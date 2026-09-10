# 배포

에이전트 서버를 재배포해도 그 번호로 오는 전화가 끊기지 않게 하는 방법입니다. 처음이시면 1번부터 순서대로 따라오시면 됩니다.

| | 단계 | 하실 일 |
|---|---|---|
| 1 | SDK 설치 | 한 줄 |
| 2 | 에이전트 코드 | 5줄 |
| 3 | 컨테이너 이미지 | Dockerfile 한 줄 확인 |
| 4 | 배포 설정 | 붙여넣기 |
| 5 | 배포하고 확인 | 한 번 |
| 6 | 인스턴스 늘리기 | 선택 |

**애플리케이션 코드는 배포 방식과 무관합니다.** 무중단은 SDK 와 배포 설정이 만듭니다.

---

## 1. SDK 설치

```bash
npm install @teamlearners/clawops@latest
```

```bash
npm ls @teamlearners/clawops
# └── @teamlearners/clawops@0.43.0   ← 이 이상이어야 합니다
```

> `0.43.0` 미만에서는 아래 설정을 전부 맞추셔도 배포 중에 전화가 끊깁니다. 버전 확인이 1번인 이유입니다.

---

## 2. 에이전트 코드

`serve()` 가 전부입니다. 연결·재연결·종료 절차를 SDK 가 맡습니다.

```js
import { ClawOpsAgent } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({ from: '07012345678', session: mySession });

await agent.serve();
```

`serve()` 는 종료 신호를 받을 때까지 돌아오지 않습니다. 신호를 받으면 진행 중이던 통화를 마치고 스스로 반환합니다.

준비 상태 표시(`/tmp/clawops-ready`)도 **SDK 가 직접 만들고 지웁니다.** 애플리케이션에서 손대실 것이 없습니다.

---

## 3. 컨테이너 이미지

**한 줄만 확인하시면 됩니다.** 실행 명령이 배열 형태여야 하고, `npm start` 로 띄우시면 안 됩니다.

```dockerfile
CMD ["node", "app.js"]     # ✅
CMD node app.js            # ⛔ PID 1 이 /bin/sh 가 됩니다
CMD ["npm", "start"]       # ⛔ PID 1 이 npm 이 됩니다
```

셸도 npm 도 종료 신호를 자식에게 전달하지 않습니다. SDK 가 종료를 듣지 못한 채 새 전화를 계속 받다가 마지막에 전부 끊깁니다.

`0.43.0` 부터는 이 상태로 뜨면 기동 로그에 경고가 찍힙니다.

---

## 4. 배포 설정

### 쿠버네티스

`image` 와 `secretKeyRef` 만 바꿔서 그대로 쓰시면 됩니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-agent
spec:
  replicas: 1 # 여러 개 두셔도 됩니다 — 6번
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0 # 옛 pod 를 먼저 내리지 않는다
      maxSurge: 1 # 새 pod 를 먼저 띄운다
  selector:
    matchLabels:
      app: my-agent
  template:
    metadata:
      labels:
        app: my-agent
    spec:
      # ⚠️ 기본값 30초를 그대로 두면 통화 중에 강제 종료됩니다.
      #    통화 길이보다 길게 잡으세요.
      terminationGracePeriodSeconds: 600
      containers:
        - name: agent
          image: my-registry/my-agent:v1
          command: ["node", "app.js"] # 3번 참고
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

세 값이 핵심입니다.

| 값 | 왜 |
|---|---|
| `maxUnavailable: 0` | 옛 pod 를 먼저 내리지 않습니다. 0이 아니면 그 사이가 그대로 불통 구간이 됩니다 |
| `maxSurge: 1` | 새 pod 를 먼저 띄웁니다 |
| `terminationGracePeriodSeconds` | 종료 유예. **통화 길이보다 길어야 합니다** |

### ECS

```json
{
  "family": "my-agent",
  "containerDefinitions": [
    {
      "name": "agent",
      "image": "my-registry/my-agent:v1",
      "command": ["node", "app.js"],
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

서비스 쪽:

```json
"deploymentConfiguration": {
  "minimumHealthyPercent": 100,
  "maximumPercent": 200
}
```

`minimumHealthyPercent` 가 100 미만이면 ECS 는 옛 태스크를 먼저 내립니다 — 쿠버네티스의 `maxUnavailable: 0` 과 같은 자리입니다.

> ⚠️ **ECS `stopTimeout` 은 120초가 AWS 상한입니다.** 통화가 그보다 길면 롤링 배포에서 남은 통화가 끊깁니다. 그럴 때는 6번의 Blue/Green 을 쓰시거나, 유예에 상한이 없는 쿠버네티스를 쓰셔야 합니다.

---

## 5. 배포하고 확인

```bash
kubectl apply -f deployment.yaml
kubectl get pods -w
```

이 순서로 보이면 정상입니다.

```
my-agent-aaa   1/1   Running       # 옛 pod — 계속 전화를 받는 중
my-agent-bbb   0/1   Running       # 새 pod — 아직 연결 전 (프로브가 막고 있음)
my-agent-bbb   1/1   Running       # 새 pod 연결됨
my-agent-aaa   1/1   Terminating   # 이제서야 옛 pod 가 내려간다
```

**옛 pod 가 `Terminating` 으로 한동안 남아 있는 것은 정상입니다** — 진행 중이던 통화를 마치는 중입니다.

옛 인스턴스 로그에 이 네 줄이 순서대로 나오면 제대로 동작한 것입니다.

```
SIGTERM 수신 — 종료 절차 시작
인계 대기 — 자리를 유지한 채 후임을 기다린다 (최대 20s)
인계 완료 — 새 전화는 후임이 받는다
Drain 완료(6.2s): 3건 모두 정상 종료
```

**첫 줄이 없으면 종료 신호가 프로세스까지 닿지 않은 것입니다** → 3번.

설정이 실제로 들어갔는지 확인하시려면:

```bash
kubectl get deploy my-agent -o jsonpath='{.spec.strategy.rollingUpdate}{"\n"}'
# {"maxSurge":1,"maxUnavailable":0}

kubectl get deploy my-agent -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}{"\n"}'
# 600

kubectl get deploy my-agent -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}{"\n"}'
# {"exec":{"command":["cat","/tmp/clawops-ready"]},...}   ← 비어 있으면 프로브가 없는 것입니다
```

---

## 6. 인스턴스 늘리기

번호 하나에 인스턴스를 여러 개 붙이실 수 있습니다. 걸려오는 전화는 그 순간 **진행 중인 통화가 가장 적은 인스턴스**로 갑니다.

```yaml
spec:
  replicas: 3
```

서버 쪽에서 처리하므로 **애플리케이션 코드도 SDK 버전도 더 바꾸실 것이 없습니다.**

### 오토스케일링 (HPA)

증설과 축소 둘 다 됩니다. 축소로 내려가는 인스턴스는 종료 신호를 받고 **자기가 들고 있던 통화를 끝까지 처리한 뒤** 종료합니다 — 롤링 배포와 같은 동작이고, 조건도 같습니다.

> **종료 유예가 통화 길이보다 길어야 합니다.**

| 축소 3 → 1 | 잘린 통화 |
|---|---|
| 유예 150초 · 통화 8초 | **0** |
| 유예 30초(쿠버네티스 기본값) · 통화 45초 | **13건** |

### Blue/Green

ECS 처럼 종료 유예에 상한이 있는 환경에서 통화가 그보다 길 때 쓰십니다.

1. 그린 서비스를 띄웁니다 — 이 시점부터 전화가 블루와 그린으로 나뉩니다
2. 블루에서 `drain()` 을 호출합니다 — 새 전화는 그린으로만 가고, 블루는 자기 통화를 기다립니다
3. 블루 프로세스가 **스스로** 종료됩니다 — 오케스트레이터가 종료시키는 것이 아니라 `stopTimeout` 과 무관합니다
4. 블루 서비스를 내립니다

```ts
// 블루 인스턴스에서 — 예: 관리용 엔드포인트가 호출
const { completed, forced } = await agent.drain(); // 상한 없음: 통화가 끝날 때까지
```

---

## 트러블슈팅

| 증상 | 원인 | 조치 |
|---|---|---|
| 배포할 때마다 수십 초~수 분 전화가 안 됨 | 옛 인스턴스를 먼저 내리는 설정 | `maxUnavailable: 0` / `minimumHealthyPercent: 100` → 4번 |
| 배포 중 통화가 도중에 끊김 | 종료 유예 < 통화 길이 | `terminationGracePeriodSeconds` / `stopTimeout` 을 늘림 |
| 로그에 `SIGTERM 수신` 이 안 찍힘 | PID 1 이 셸이거나 npm | `CMD` 를 배열 형태로 → 3번 |
| 불통 지표는 멀쩡한데 통화가 무더기로 끊김 | 위와 같음 | 위와 같음 |
| pod 가 영영 `0/1` | 프로브가 준비 표시를 못 읽음 | 아래 「read-only 파일시스템」 |
| `cat: not found` (distroless) | 이미지에 `cat` 이 없음 | 아래 「HTTP 프로브」 |
| 스케일인·정지에서 전화가 끊김 | 후임이 없는데 자리를 붙들고 기다림 | `serve({ handoverWaitMs: 0 })` |
| 인스턴스 여러 개가 서로 밀어냄 · `CrashLoopBackOff` | SDK 가 `0.43.0` 미만 | 1번 |
| `call_end` 의 `ended_duration` 이 `null` | 드레이닝 중에 끝난 통화 | 통화 조회 API 로 확인 |

### read-only 파일시스템

SDK 가 준비 표시를 `/tmp/clawops-ready` 에 씁니다. `/tmp` 가 읽기 전용이면 표시를 남기지 못해 **프로브가 영영 통과하지 못합니다**(기동 로그에 경고가 찍힙니다).

```yaml
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
```

### HTTP 프로브

exec 프로브는 컨테이너 안에서 명령을 실행하는 것이라, distroless 처럼 `cat` 이 없는 이미지에서는 성립하지 않습니다.

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

준비되면 200, 아니면 503입니다. 파일과 달리 낡은 상태가 남을 수 없다는 장점도 있습니다.

### 종료 유예를 얼마로 잡을까

SDK 는 종료 신호를 받으면 **진행 중인 통화가 끝날 때까지 기다립니다**(상한 없음이 기본값입니다). 통화를 끊는 것은 플랫폼의 강제 종료 하나뿐이고, 그래서 **유예가 곧 통화 상한**이 됩니다.

| | 기본값 | 권장 |
|---|---|---|
| 쿠버네티스 `terminationGracePeriodSeconds` | **30초** | 통화 길이보다 길게 (상한 없음) |
| ECS `stopTimeout` | 30초 | 120 (AWS 상한) |

유예 안에 스스로 정리하게 하시려면 마감을 직접 주시면 됩니다. 유예보다 조금 짧게 잡으세요.

```js
await agent.serve({ drainTimeoutMs: 100_000, shutdownDeadlineMs: 110_000 }); // ECS stopTimeout 120 일 때
```

### readinessProbe 는 왜 계속 필요한가

`0.43.0` 부터는 프로브가 없어도 배포 중 빈틈이 생기지 않습니다. 그래도 권장합니다.

프로브가 막는 것은 **시간 빈틈이 아니라 나쁜 후임**입니다. 새 인스턴스가 설정 오류로 crash-loop 에 빠지면, 프로브가 있을 때는 옛 pod 에 종료 신호가 **아예 가지 않습니다.** 프로브를 빼면 옛 것이 내려가고 롤백할 때까지 전면 불통이 됩니다.

앱 기동이 인계 대기 상한(기본 20초)보다 오래 걸릴 때도 그 차이만큼 빈틈이 남습니다.

| 앱 기동 | 프로브 없음 | 프로브 있음 |
|---|---|---|
| 12초 | 빈틈 없음 | 빈틈 없음 |
| 35초 | **11초 불통** | 빈틈 없음 |

---

## 직접 제어하기

`serve()` 대신 수명을 직접 다루실 때 쓰시는 것들입니다.

```ts
const agent = new ClawOpsAgent({
  from: '07012345678',
  session: mySession,
  onTakenOver: (code, reason) => console.log('자리를 넘겼습니다:', reason),
});
await agent.connect();

// ... 종료할 때
const { completed, forced } = await agent.drain();
```

| | 설명 |
|---|---|
| `onTakenOver` | 다른 인스턴스가 이 번호를 넘겨받았을 때 호출됩니다. 롤링 배포의 한가운데이고 오류가 아닙니다 |
| `agent.takenOver` | 넘겨준 상태인지 여부 |
| `drain({ timeoutMs })` | 새 전화를 받지 않고 진행 중 통화를 기다린 뒤 종료합니다. `{ completed, forced }` 를 돌려줍니다 |
| `disconnect()` | 통화 도중이라도 즉시 끊습니다 |

배포에는 `drain()` 을 쓰십시오. `disconnect()` 는 "지금 멈춰라" 일 때는 맞고 "넘겨라" 일 때는 틀립니다.

---

## 참고: 배포 중에 무슨 일이 일어나나

control 연결은 **번호마다 하나**이고, 그 연결이 전화를 어디로 보낼지 정하는 자리입니다. 배포란 그 자리를 옮기는 일입니다.

`0.43.0` 미만에서는 종료 신호를 받는 **즉시 자리를 놓았습니다.** 그때 새 인스턴스가 아직 안 떠 있으면 그 사이 오는 전화가 전부 죽었습니다. 배포 한 번에 수 분씩 전화가 안 되던 것이 이것입니다.

`0.43.0` 부터는 두 국면을 지납니다.

1. **인계 대기** — 자리를 놓지 않고 계속 전화를 받습니다. 후임이 붙어 서버가 자리를 넘길 때까지, 또는 `handoverWaitMs`(기본 20초)까지
2. **드레이닝** — 새 전화는 후임에게 갑니다. 진행 중이던 통화만 끝까지 기다립니다

1번이 배포의 빈틈을 없애고, 2번이 절단을 없앱니다. 2번이 얼마나 걸리든 플랫폼이 기다려 주어야 하므로, 종료 유예가 유일한 설정 조건입니다.

번호 하나에 인스턴스를 여러 개 두실 때는 자리도 여러 개가 됩니다. 서로 밀어내지 않고, 각자 자기 통화를 들고 있다가 자기 몫만 마치고 나갑니다.
