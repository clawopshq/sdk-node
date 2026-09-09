# 배포

에이전트 서버를 재배포할 때 통화가 끊기지 않게 하는 방법입니다.

무중단 배포는 **@teamlearners/clawops 0.42.0 이상**에서 동작합니다. 그 이전 버전은 아래 설정을 해도 교체 중에 콜이 끊깁니다.

## 왜 배포할 때 끊기나

에이전트는 Control WS로 서버에 상시 연결해 인바운드 콜 알림을 받습니다. 이 연결은 **전화번호 하나에 하나**입니다 — 콜을 어디로 보낼지 정하는 자리이기 때문입니다.

그래서 인스턴스를 내렸다가 올리면, 그 사이에는 콜을 받을 곳이 없습니다. 걸려온 전화는 연결되지 못하고 종료됩니다.

**불통 구간의 길이는 새 인스턴스가 뜨는 데 걸리는 시간과 같습니다.** 이미지를 받고 프로세스가 기동하는 데 3분이 걸린다면 3분간 전화가 안 됩니다. 배포를 빠르게 만드는 것으로는 이 구간을 없앨 수 없습니다 — 겹치게 배포해야 없어집니다.

## 맞춰야 하는 네 가지

| | 안 맞추면 |
| --- | --- |
| **겹치게 배포** — 새 인스턴스를 먼저 띄우고 옛 것을 내린다 | 그 사이 전화가 안 걸린다 |
| **준비 판정** — Control 연결이 붙은 뒤에 "정상"으로 본다 | 겹치게 배포해도 그 사이가 빈다 |
| **종료 유예** — 드레이닝 상한보다 길게 | 통화 도중에 `SIGKILL` 로 끊긴다 |
| **시그널 전달** — 종료 시그널이 프로세스까지 닿는다 | 드레이닝이 시작조차 안 된다 |

앞의 셋은 배포 설정이고, 마지막은 컨테이너 이미지의 문제입니다. **하나라도 빠지면 무중단이 되지 않습니다.**

## 애플리케이션

`serve()`를 쓰고 있다면 인계와 드레이닝은 SDK가 처리합니다. 준비 표시 한 줄만 더하면 됩니다.

```typescript
import { writeFileSync } from 'node:fs';
import { ClawOpsAgent } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({ from: '0705...', session });

await agent.connect();
writeFileSync('/tmp/clawops-ready', ''); // 여기서부터 이 인스턴스가 콜을 받는다
await agent.serve();                     // 멈출 때가 되면 진행 중 통화를 마치고 반환한다
```

`connect()`는 Control 연결이 **실제로 붙은 뒤에** 반환합니다. 그래서 이 파일이 생긴 시점이 곧 "이 인스턴스가 콜을 받을 수 있게 된 시점"이고, 헬스체크가 그걸 보면 됩니다.

## 쿠버네티스

전체 매니페스트입니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-agent
spec:
  replicas: 1 # 번호 하나에 인스턴스 하나 (아래 「인스턴스는 하나로 두세요」)
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0 # 옛 pod 를 먼저 내리지 않는다
      maxSurge: 1 # 새 pod 를 하나 더 띄운다
  selector:
    matchLabels:
      app: my-agent
  template:
    metadata:
      labels:
        app: my-agent
    spec:
      terminationGracePeriodSeconds: 150 # 드레이닝 상한보다 길게. 기본값 30 은 짧다
      containers:
        - name: agent
          image: my-registry/my-agent:v1
          command: ["node", "dist/app.js"] # 시그널이 닿게 (아래 「시그널」)
          env:
            - name: CLAWOPS_API_KEY
              valueFrom:
                secretKeyRef:
                  name: clawops
                  key: apiKey
          readinessProbe: # 붙은 뒤에야 Ready 로 본다
            exec:
              command: ["cat", "/tmp/clawops-ready"]
            periodSeconds: 2
            failureThreshold: 30 # 기동이 느려도 기다린다
```

**`readinessProbe`가 없으면 겹치게 배포해도 그 사이가 빕니다.** probe가 없으면 pod는 컨테이너가 뜬 순간 Ready가 되고, `kubectl rollout status`는 애플리케이션이 Control 연결을 붙이기도 **전에** 완료로 떨어집니다. 그 시점에 옛 pod가 내려가므로, 새 인스턴스가 붙을 때까지 전화가 안 걸립니다.

**배포 전략의 기본값은 그대로 두어도 위험하지 않습니다.** `maxUnavailable: 25%` · `maxSurge: 25%`는 `replicas: 1`에서 각각 0과 1로 떨어져 위 설정과 같아집니다. 명시해 두는 편이 낫지만, 실제로 위험한 기본값은 이쪽이 아니라 **`terminationGracePeriodSeconds: 30`** 입니다.

`command`를 매니페스트에 두면 이미지의 `CMD` 형식과 무관하게 시그널이 프로세스에 닿습니다 — 쿠버네티스의 `command`는 배열이라 셸을 거치지 않기 때문입니다.

지금 설정이 맞는지 확인:

```bash
kubectl get deploy my-agent -o jsonpath='maxUnavailable={.spec.strategy.rollingUpdate.maxUnavailable} maxSurge={.spec.strategy.rollingUpdate.maxSurge} grace={.spec.template.spec.terminationGracePeriodSeconds}{"\n"}'
# maxUnavailable=0 maxSurge=1 grace=150

kubectl get deploy my-agent -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}{"\n"}'
# {"exec":{"command":["cat","/tmp/clawops-ready"]},...}   ← 비어 있으면 probe 가 없는 것입니다
```

배포해 보고 확인:

```bash
kubectl rollout restart deploy/my-agent
kubectl get pods -w
# 새 pod 이 Ready 가 된 **뒤에** 옛 pod 이 Terminating 으로 바뀌어야 합니다.
# 옛 pod 은 진행 중이던 통화가 끝날 때까지 Terminating 상태로 남아 있습니다 — 정상입니다.
```

## ECS

```json
{
  "deploymentConfiguration": {
    "minimumHealthyPercent": 100,
    "maximumPercent": 200
  },
  "containerDefinitions": [
    {
      "name": "agent",
      "image": "my-registry/my-agent:v1",
      "command": ["node", "dist/app.js"],
      "stopTimeout": 120,
      "healthCheck": {
        "command": ["CMD-SHELL", "test -f /tmp/clawops-ready"],
        "interval": 5,
        "retries": 12,
        "startPeriod": 30
      }
    }
  ]
}
```

`minimumHealthyPercent`가 100 미만이면 ECS는 옛 태스크를 먼저 내립니다. 그 사이가 그대로 불통 구간입니다. `maximumPercent`도 200이어야 합니다 — 100이면 태스크를 하나 넘게 띄울 수 없어서 결국 옛 것을 먼저 내리게 됩니다.

`healthCheck`가 없으면 ECS는 **컨테이너가 실행된 순간** 태스크를 정상으로 보고 교체를 시작합니다. 쿠버네티스의 `readinessProbe`와 같은 이유로 필요합니다.

`stopTimeout`은 **120초가 상한**입니다(기본값 30초). 드레이닝 상한을 그 안에 들어오게 잡으세요.

## 종료 유예와 드레이닝 상한

`serve()`는 멈출 때가 되면 **진행 중인 통화가 끝나기를 기다린 뒤** 종료합니다. 기본 상한은 120초입니다.

그보다 먼저 오케스트레이터가 프로세스를 강제 종료하면(`SIGKILL`) 통화가 도중에 끊깁니다. 그래서 플랫폼의 종료 유예가 드레이닝 상한보다 **길어야** 합니다.

| 플랫폼 | 설정 | 기본값 | 권장 |
| --- | --- | --- | --- |
| Kubernetes | `terminationGracePeriodSeconds` | 30초 | 드레이닝 상한 + 30초 |
| ECS | `stopTimeout` | 30초 | 120초 (플랫폼 최대값) |

**두 플랫폼 모두 기본값이 30초입니다.** 드레이닝 상한 기본값(120초)보다 짧으므로, 양쪽을 다 기본값으로 두면 통화가 30초에서 잘립니다.

상한을 직접 정하려면:

```typescript
await agent.serve({ drainTimeoutMs: 90_000 });
```

통화가 평균적으로 얼마나 긴지에 맞춰 잡으시면 됩니다. 상한에 걸린 통화는 종료됩니다. 상한에 걸려 끝나는 편이 `SIGKILL` 로 잘리는 것보다 낫습니다 — 종료 처리가 정상적으로 돕니다.

## 시그널이 프로세스까지 닿아야 합니다

종료 시그널은 **컨테이너의 PID 1 에게만** 갑니다. `CMD`를 셸 형식으로 쓰면 PID 1이 `/bin/sh`가 되는데, `sh`는 그 시그널을 자식에게 전달하지 않습니다. 그러면 SDK는 종료 요청을 **듣지 못하고**, 드레이닝은 시작조차 하지 않은 채 유예 시간이 지나 `SIGKILL`이 옵니다. 진행 중이던 통화가 전부 그 자리에서 끊깁니다.

배포 설정을 아무리 맞춰도 이 층에서 막히면 무중단은 되지 않습니다. 그리고 **배달 지표로는 드러나지 않습니다** — 전화는 계속 걸리고, 끊기는 건 이미 통화 중이던 사람들입니다.

```dockerfile
CMD ["node", "dist/app.js"]   # ✅ PID 1 = node — 시그널이 닿는다
```

```dockerfile
CMD node dist/app.js          # ⛔ PID 1 = /bin/sh — 시그널이 안 닿는다
```

```dockerfile
CMD ["npm", "start"]          # ⛔ PID 1 = npm — 드레이닝할 틈 없이 죽는다
```

`npm start` 는 셸 형식보다도 나쁩니다. npm 이 `SIGTERM` 을 받으면 자식 프로세스를 **곧바로** 죽여서, 유예 시간이 아무리 길어도 드레이닝이 시작되지 않습니다. 진입점에서는 런타임을 직접 부르세요.

지금 쓰는 이미지가 어느 쪽인지는 이렇게 확인합니다.

```bash
docker run -d --name check <이미지>
docker exec check cat /proc/1/cmdline | tr '\0' ' '
# node dist/app.js        → 괜찮습니다
# /bin/sh -c node ...     → 위 형식으로 고치세요
```

이미지를 고치기 어렵다면 배포 설정에서 덮어써도 됩니다 — 쿠버네티스의 `command`, ECS의 `command`는 둘 다 배열이라 셸을 거치지 않습니다. init 프로세스를 넣는 방법도 있습니다(Docker `--init`, ECS `initProcessEnabled: true`, 이미지에 `tini`).

## 옛 인스턴스는 어떻게 물러나나

두 가지 경로가 있습니다. 인계 통지를 받으면 스스로 드레이닝하고 종료하며, 통지를 받지 못한 경우에는 새 콜을 받지 않는 상태로 남아 있다가 종료 시그널을 받을 때 드레이닝을 거쳐 종료합니다. 접속하는 서버에 따라 갈리므로 어느 쪽일지는 미리 알 수 없지만, **통화가 보호되는 것과 새 콜이 새 인스턴스로 가는 것은 두 경우 모두 같습니다.**

> **옛 인스턴스를 내리는 단계는 생략하지 마세요.** 통지를 받지 못하면 스스로 종료하지 않습니다. 롤링 배포는 어차피 옛 인스턴스를 내리므로 보통은 문제가 되지 않지만, "새 것만 띄우면 옛 것이 알아서 사라진다"고 가정하면 안 됩니다.

## 직접 제어하기

`connect()`로 직접 수명을 관리한다면 두 가지를 쓰시면 됩니다.

```typescript
const agent = new ClawOpsAgent({
  from: '0705...',
  session,
  onTakenOver: () => console.log('다른 인스턴스가 넘겨받았습니다'),
});
await agent.connect();

// ... 종료할 때
const { completed, forced } = await agent.drain({ timeoutMs: 120_000 });
console.log(`${completed}건 정상 종료, ${forced}건 중단`);
```

| | 설명 |
| --- | --- |
| `onTakenOver` | 다른 인스턴스가 이 번호를 넘겨받았을 때 호출됩니다. 롤링 배포의 한가운데이고, 오류가 아닙니다. 여기서 `drain()`을 부르면 됩니다. |
| `agent.takenOver` | 넘겨준 상태인지 여부. |
| `drain({ timeoutMs })` | 새 콜 수신을 멈추고 진행 중 통화를 기다린 뒤 종료합니다. `{ completed, forced }`를 돌려줍니다. |

`disconnect()`는 기다리지 않고 즉시 끊습니다. 배포에는 `drain()`을 쓰세요.

드레이닝 중에 끝나는 통화는 `call_end`의 `endedDuration`이 `null`입니다. 통화 시간은 Control 연결로 오는데 그 연결을 이미 내려놓은 뒤이기 때문입니다. 통화 시간이 필요하면 통화 조회 API를 쓰세요.

## 인스턴스는 하나로 두세요

**한 번호에 인스턴스를 여러 개 붙이지 마세요.** `replicas`는 1이어야 합니다.

Control 연결이 번호당 하나이므로, 같은 번호로 여러 인스턴스가 붙으면 서로 자리를 뺏습니다. 새 인스턴스가 뜰 때마다 앞의 인스턴스가 물러나고, 오케스트레이터는 죽은 자리를 다시 채우고, 그것이 또 남은 것을 밀어냅니다. 이 상태가 이어지면 **그 번호로 한동안 전화를 받지 못하게 됩니다.**

HPA(오토스케일링)도 같은 이유로 이 Deployment에는 걸지 마세요.

```yaml
# ⛔ 이렇게 하지 마세요
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef:
    name: my-agent
  minReplicas: 2
```

Control 연결은 콜 알림만 주고받고 오디오는 통화별 Media WS로 흐르기 때문에, 인스턴스 하나가 감당하는 동시 통화 수는 대개 CPU와 사용하는 모델의 한도가 정합니다 — 연결 수가 아닙니다. 부하가 걱정된다면 `replicas`를 늘리는 대신 pod의 CPU/메모리를 키우세요.

번호를 여러 개 쓰신다면 **번호마다 Deployment를 하나씩** 두는 것은 문제없습니다.

```yaml
# 번호 A 용 Deployment (replicas: 1)
# 번호 B 용 Deployment (replicas: 1)
# ...
```

지금 규모에서 부족하다면 문의해 주세요.
