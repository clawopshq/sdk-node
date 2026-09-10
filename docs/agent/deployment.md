# 배포

에이전트를 재배포할 때 그 번호로 오는 전화가 끊기지 않게 하는 법입니다.

**세 단계입니다.** SDK를 올리고, 배포 설정을 붙여넣고, 한 번 확인합니다.
애플리케이션 코드는 바뀌지 않습니다.

---

## 왜 배포할 때 끊기나

control 연결은 **번호마다 하나**입니다. 그 연결이 전화를 어디로 보낼지 정하는 자리이고,
배포란 그 자리를 옮기는 일입니다.

예전 SDK는 종료 신호(SIGTERM)를 받는 **즉시 자리를 놓았습니다.** 그때 새 인스턴스가 아직
안 떠 있으면 그 사이 오는 전화가 전부 죽었습니다.

`0.43.0` 부터는 자리를 바로 놓지 않고 새 인스턴스가 붙을 때까지 **계속 전화를 받습니다.**
새 인스턴스가 붙으면 서버가 인계를 알려 주고, 그때 진행 중이던 통화만 마치고 나갑니다.

---

## 1. SDK를 올립니다

```bash
npm install @teamlearners/clawops@latest
```

확인:

```bash
npm ls @teamlearners/clawops
# └── @teamlearners/clawops@0.43.0   ← 이 이상이어야 합니다
```

애플리케이션 코드는 그대로 둡니다. 예전 문서가 시키던 준비 표시 파일 만드는 줄이 있다면
**지워도 됩니다** — 이제 SDK가 씁니다.

```js
import { ClawOpsAgent } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({ from: '07012345678', session: mySession });

await agent.serve();      // connect() 도 같이 합니다
```

---

## 2. 배포 설정을 붙여넣습니다

### 쿠버네티스

아래를 그대로 쓰고 `image` 와 `secretKeyRef` 만 바꾸세요.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-agent
spec:
  # 여러 개 두어도 됩니다. 아래 "인스턴스를 여러 개 두기" 참고.
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0     # 옛 것을 먼저 내리지 않는다
      maxSurge: 1           # 새 것을 먼저 띄운다
  selector:
    matchLabels:
      app: my-agent
  template:
    metadata:
      labels:
        app: my-agent
    spec:
      # ⚠️ 기본값은 30초입니다. 그대로 두면 통화 중에 SIGKILL 이 옵니다.
      terminationGracePeriodSeconds: 150
      containers:
        - name: agent
          image: my-registry/my-agent:v1
          # ⚠️ 배열 형태여야 합니다. 문자열로 쓰거나 npm 으로 띄우면 종료 신호가 안 닿습니다.
          command: ["node", "dist/index.js"]
          env:
            - name: CLAWOPS_API_KEY
              valueFrom:
                secretKeyRef:
                  name: clawops
                  key: api-key
          readinessProbe:
            exec:
              command: ["cat", "/tmp/clawops-ready"]
            periodSeconds: 2
            failureThreshold: 30
```

`/tmp/clawops-ready` 는 **SDK가 만들고 지웁니다.** 연결되면 만들고, 자리를 넘기거나 종료
절차에 들어가면 지웁니다. 애플리케이션이 손댈 필요가 없습니다.

> **read-only 파일시스템을 쓰신다면** `/tmp` 에 쓰기 가능한 볼륨을 붙여 주세요.
>
> ```yaml
>           volumeMounts:
>             - name: tmp
>               mountPath: /tmp
>       volumes:
>         - name: tmp
>           emptyDir: {}
> ```
>
> 안 붙이면 SDK가 표시를 못 남기고 **프로브가 영영 통과하지 못합니다.** 그 경우 기동 로그에
> 경고가 찍힙니다.

### ECS

```json
{
  "family": "my-agent",
  "containerDefinitions": [
    {
      "name": "agent",
      "image": "my-registry/my-agent:v1",
      "command": ["node", "dist/index.js"],
      "stopTimeout": 120,
      "healthCheck": {
        "command": ["CMD-SHELL", "cat /tmp/clawops-ready || exit 1"],
        "interval": 5,
        "retries": 12,
        "startPeriod": 60
      }
    }
  ]
}
```

서비스 쪽 배포 설정:

```json
"deploymentConfiguration": {
  "minimumHealthyPercent": 100,
  "maximumPercent": 200
}
```

> **ECS `stopTimeout` 은 최대 120초입니다.** 그래서 SDK의 종료 마감도 기본 110초입니다 —
> 그 안에 정리를 마치도록 맞춰 둔 값입니다.

---

## 3. 배포해 보고 확인합니다

### 쿠버네티스

```bash
kubectl apply -f deployment.yaml
kubectl get pods -w
```

이런 순서로 보이면 정상입니다:

```
my-agent-aaa   1/1   Running       # 옛 pod — 계속 전화를 받는 중
my-agent-bbb   0/1   Running       # 새 pod — 아직 연결 전 (프로브가 막고 있음)
my-agent-bbb   1/1   Running       # 새 pod 연결됨
my-agent-aaa   1/1   Terminating   # 이제서야 옛 pod 이 내려간다
```

**옛 pod 이 `Terminating` 으로 한동안 남아 있는 것은 정상입니다** — 진행 중이던 통화를
마치는 중입니다.

설정이 실제로 들어갔는지:

```bash
kubectl get deploy my-agent -o jsonpath='{.spec.strategy.rollingUpdate}{"\n"}'
# {"maxSurge":1,"maxUnavailable":0}

kubectl get deploy my-agent -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}{"\n"}'
# 150

kubectl get deploy my-agent -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}{"\n"}'
# {"exec":{"command":["cat","/tmp/clawops-ready"]},...}   ← 비어 있으면 프로브가 없는 것입니다
```

### 로그에서 확인할 것

옛 인스턴스 로그에 이 세 줄이 순서대로 나오면 제대로 동작한 것입니다.

```
SIGTERM received — beginning shutdown
Waiting for a successor — still holding the slot (up to 20000ms)
Handover complete — new calls go to the successor
Drain complete in 6200ms: all 3 call(s) finished
```

**첫 줄이 없으면 종료 신호가 프로세스까지 안 닿은 것입니다.** 아래를 보세요.

---

## 자주 걸리는 것 넷

### 종료 신호가 프로세스까지 안 닿는 경우

`CMD node dist/index.js` 를 셸 형태로 쓰거나 `npm start` 로 띄우면 PID 1이 셸이나 npm이
되는데, 둘 다 SIGTERM을 자식에게 전달하지 않습니다. SDK는 종료를 못 듣고, 유예가 끝날
때까지 새 전화를 계속 받다가 **SIGKILL로 전부 끊깁니다.**

**이게 위험한 이유는 불통 지표에 안 잡히기 때문입니다.** 저희 실측에서 45초 통화 기준
26건이 통째로 잘렸는데 불통은 0이었습니다.

```dockerfile
CMD ["node", "dist/index.js"]      # ✅ 배열 형태
CMD node dist/index.js             # ⛔ PID 1 이 /bin/sh 가 됩니다
CMD ["npm", "start"]               # ⛔ npm 도 전달하지 않습니다
```

`0.43.0` 부터는 이 상태로 뜨면 **기동 로그에 경고가 찍힙니다.**

### 유예가 드레이닝보다 짧은 경우

SDK는 종료 신호를 받으면 진행 중인 통화를 최대 110초까지 기다립니다. 플랫폼의 유예가
그보다 짧으면 그 도중에 SIGKILL이 옵니다.

| | 기본값 | 권장 |
|---|---|---|
| 쿠버네티스 `terminationGracePeriodSeconds` | **30초** | 150 |
| ECS `stopTimeout` | 30초 | 120 (최대값) |

**쿠버네티스 기본값 30초를 그대로 두면 긴 통화가 잘립니다.** 실측에서 45초 통화 9건이
그렇게 끊겼습니다. lame duck은 *빈틈*을 닫지 *절단*을 막지 못합니다 — 이건 설정으로만
해결됩니다.

통화가 그보다 길 수 있다면 상한을 조절하세요.

```js
await agent.serve({ drainTimeoutMs: 300_000, shutdownDeadlineMs: 310_000 });
```

플랫폼 유예를 `shutdownDeadlineMs` 보다 길게 잡는 것을 잊지 마세요.

### `cat` 이 없는 이미지 (distroless 등)

exec 프로브는 컨테이너 안에서 명령을 실행하는 것이라, 실행할 바이너리가 없으면 프로브
자체가 성립하지 않습니다. 그럴 때는 HTTP 프로브를 쓰세요.

```js
await agent.serve({ healthPort: 8080 });
```

```yaml
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 2
            failureThreshold: 30
```

준비되면 200, 아니면 503입니다. 파일과 달리 **낡은 상태가 남을 수 없다**는 장점도 있습니다.

### 새 인스턴스를 안 띄우는 배포

스케일인이나 단순 정지처럼 **후임이 아예 없는** 경우에는 자리를 붙들고 기다리는 것이
손해입니다. 그 사이 받은 전화가 유예 만료에 끊길 수 있습니다.

```js
await agent.serve({ handoverWaitMs: 0 });   // 예전처럼 즉시 자리를 놓습니다
```

---

## readinessProbe 는 왜 계속 필요한가

`0.43.0` 부터는 프로브가 없어도 배포 중 빈틈이 생기지 않습니다. 그래도 권장합니다.

프로브가 막는 것은 **시간 빈틈이 아니라 나쁜 후임**입니다. 새 인스턴스가 설정 오류로
crash-loop에 빠지면, 프로브가 있을 때는 옛 pod 에 종료 신호가 **아예 가지 않습니다.**
프로브를 빼면 옛 것이 내려가고 롤백할 때까지 전면 불통이 됩니다.

그리고 앱 기동이 인계 대기 상한(기본 20초)보다 오래 걸리면 그 차이만큼은 빈틈이 남습니다.

| 앱 기동 | 프로브 없음 | 프로브 있음 |
|---|---|---|
| 12초 | 빈틈 없음 | 빈틈 없음 |
| 35초 | **11초 불통** | 빈틈 없음 |

---

## 인스턴스를 여러 개 두기

**한 번호에 인스턴스를 여러 개 붙일 수 있습니다.** `replicas` 를 늘리셔도 되고 HPA 를 거셔도
됩니다. 걸려오는 전화는 그 순간 **진행 중인 통화가 가장 적은 인스턴스**로 갑니다.

```yaml
spec:
  replicas: 3
```

서버 쪽에서 처리하므로 **애플리케이션 코드도 SDK 버전도 바꾸실 필요가 없습니다.**

### 오토스케일링

증설과 축소 둘 다 안전합니다. 축소로 내려가는 인스턴스는 `SIGTERM` 을 받고 **자기가 들고 있던
통화를 끝까지 처리한 뒤** 종료합니다 — 롤링 배포와 같은 동작이고, 조건도 같습니다:

> **종료 유예가 통화 길이보다 길어야 합니다.** 유예가 짧으면 축소든 배포든 남은 통화가 끊깁니다.

| 축소 3 → 1 | 잘린 통화 |
| --- | --- |
| 유예 150초 · 통화 8초 | **0** |
| 유예 30초(k8s 기본) · 통화 45초 | **13건** (+ SIGKILL 2) |

### Blue/Green

ECS 처럼 종료 유예에 상한이 있는 환경(`stopTimeout` 최대 120초)에서 통화가 그보다 길면,
롤링 배포로는 절단을 완전히 없앨 수 없습니다. Blue/Green 이 그 답입니다.

1. 그린 서비스를 띄웁니다 — 이 시점부터 콜이 블루와 그린으로 나뉩니다
2. 블루에서 `drain()` 을 호출합니다 — 새 콜은 그린으로만 가고, 블루는 자기 통화를 기다립니다
3. 블루 프로세스가 **스스로** 종료됩니다 — 오케스트레이터가 죽이는 게 아니라 유예 상한과 무관합니다
4. 블루 서비스를 내립니다

```ts
// 블루 인스턴스에서 — 예: 관리용 엔드포인트가 호출
const { completed, forced } = await agent.drain(); // 기본 상한 없음
```

---

## 직접 제어하기

`serve()` 대신 직접 다루고 싶다면:

```js
await agent.connect();

// ... 종료할 때
const { completed, forced } = await agent.drain({ timeoutMs: 120_000 });
```

`drain()` 은 새 전화를 받지 않고 진행 중인 통화만 기다립니다. `disconnect()` 는 통화
도중이라도 즉시 끊습니다 — "지금 멈춰라" 일 때는 맞고 "넘겨라" 일 때는 틀립니다.

인계 통지를 직접 받고 싶다면:

```js
const agent = new ClawOpsAgent({
  from: '07012345678',
  session: mySession,
  onTakenOver: ({ code, reason }) => console.log('자리를 넘겼습니다:', reason),
});
```
