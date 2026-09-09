# 배포

에이전트 서버를 재배포할 때 통화가 끊기지 않게 하는 방법입니다.

무중단 배포는 **@teamlearners/clawops 0.42.0 이상**에서 동작합니다. 그 이전 버전은 아래 설정을 해도 교체 중에 콜이 끊깁니다.

## 왜 배포할 때 끊기나

에이전트는 Control WS로 서버에 상시 연결해 인바운드 콜 알림을 받습니다. 이 연결은 **전화번호 하나에 하나**입니다 — 콜을 어디로 보낼지 정하는 자리이기 때문입니다.

그래서 인스턴스를 내렸다가 올리면, 그 사이에는 콜을 받을 곳이 없습니다. 걸려온 전화는 연결되지 못하고 종료됩니다.

**불통 구간의 길이는 새 인스턴스가 뜨는 데 걸리는 시간과 같습니다.** 이미지를 받고 프로세스가 기동하는 데 3분이 걸린다면 3분간 전화가 안 됩니다. 배포 자체를 빠르게 만드는 것으로는 이 구간을 없앨 수 없습니다 — 겹치게 배포해야 없어집니다.

## 겹치게 배포하세요

**새 인스턴스를 먼저 띄우고, 그다음 옛 인스턴스를 내립니다.** 새 인스턴스가 연결되는 순간부터 **새 콜은 새 인스턴스로 갑니다.** 옛 인스턴스에 이미 붙어 있던 통화는 그대로 이어지고, 옛 인스턴스는 그 통화를 끝까지 처리한 뒤 물러납니다.

옛 인스턴스가 물러나는 방식은 두 가지입니다. 인계 통지를 받으면 스스로 드레이닝하고 종료하며, 통지를 받지 못한 경우에는 새 콜을 받지 않는 상태로 남아 있다가 종료 시그널을 받을 때 드레이닝을 거쳐 종료합니다. 접속하는 서버에 따라 갈리므로 어느 쪽일지는 미리 알 수 없지만, 통화가 보호되는 것과 새 콜이 새 인스턴스로 가는 것은 두 경우 모두 같습니다.

> **옛 인스턴스를 내리는 단계는 생략하지 마세요.** 통지를 받지 못하면 스스로 종료하지 않습니다. 롤링 배포는 어차피 옛 인스턴스를 내리므로 보통은 문제가 되지 않지만, "새 것만 띄우면 옛 것이 알아서 사라진다"고 가정하면 안 됩니다.

`serve()`를 쓰고 있다면 코드는 그대로 두어도 됩니다.

```typescript
const agent = new ClawOpsAgent({ from: '0705...', session });
await agent.serve(); // 인계받으면 알아서 드레이닝하고 반환한다
```

바꿀 것은 배포 설정입니다.

### Kubernetes

```yaml
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0 # 옛 pod 를 먼저 내리지 않는다
      maxSurge: 1
  template:
    spec:
      terminationGracePeriodSeconds: 150 # 드레이닝 상한보다 길게 (기본값 30 은 짧다)
      containers:
        - name: agent
          readinessProbe: # 붙기 전에 옛 pod 를 내리지 않게 한다
            exec:
              command: ["cat", "/tmp/clawops-ready"]
            periodSeconds: 5
```

### ECS

```json
{
  "deploymentConfiguration": {
    "minimumHealthyPercent": 100,
    "maximumPercent": 200
  },
  "containerDefinitions": [
    {
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

`minimumHealthyPercent`가 100 미만이면 ECS는 옛 태스크를 먼저 내립니다. 그 사이가 그대로 불통 구간이 됩니다. `maximumPercent`도 200이어야 합니다 — 100이면 태스크를 하나 넘게 띄울 수 없어서, 결국 옛 것을 먼저 내리게 됩니다.

## 준비됐다고 언제 말할 것인가

헬스체크가 없으면 오케스트레이터는 **컨테이너가 뜬 순간** 새 인스턴스를 정상으로 보고 옛 것을 내리기 시작합니다. 그런데 그 시점은 아직 Control 연결이 붙기 전입니다. 겹치게 배포해도 그 사이는 비게 됩니다.

`connect()`는 Control 연결이 실제로 붙은 뒤에 반환합니다. 그 자리에 표시를 남기고, 헬스체크가 그것을 보게 하세요.

```typescript
import { writeFileSync } from 'node:fs';

const agent = new ClawOpsAgent({ from: '0705...', session });
await agent.connect();
writeFileSync('/tmp/clawops-ready', ''); // 여기서부터 이 인스턴스가 콜을 받는다
await agent.serve();
```

## 종료 유예를 넉넉히 두세요

`serve()`는 멈출 때가 되면 **진행 중인 통화가 끝나기를 기다린 뒤** 종료합니다. 기본 상한은 120초입니다.

그런데 오케스트레이터가 그보다 먼저 프로세스를 강제 종료하면(`SIGKILL`) 통화가 도중에 끊깁니다. 그래서 플랫폼의 종료 유예를 드레이닝 상한보다 **길게** 잡아야 합니다.

**두 플랫폼 모두 기본값이 30초입니다.** 드레이닝 상한 기본값(120초)보다 짧으므로, 양쪽을 다 기본값으로 두면 통화가 30초에서 잘립니다. 반드시 명시하세요.

| 플랫폼     | 설정                            | 기본값 | 권장                  |
| ---------- | ------------------------------- | ------ | --------------------- |
| Kubernetes | `terminationGracePeriodSeconds` | 30초   | 드레이닝 상한 + 30초  |
| ECS        | `stopTimeout`                   | 30초   | 120초 (플랫폼 최대값) |

ECS의 `stopTimeout`은 120초가 상한입니다. 통화가 그보다 길어질 수 있다면 드레이닝 상한을 그에 맞춰 줄이세요 — 상한에 걸린 통화는 어차피 종료되지만, 드레이닝이 스스로 끝내는 편이 SIGKILL 로 잘리는 것보다 낫습니다.

상한을 직접 정하려면:

```typescript
await agent.serve({ drainTimeoutMs: 90_000 });
```

통화가 평균적으로 얼마나 긴지에 맞춰 잡으시면 됩니다. 상한에 걸린 통화는 종료됩니다.

## 컨테이너로 배포한다면

종료 시그널은 **컨테이너의 PID 1 에게만** 갑니다. `CMD` 를 셸 형식으로 쓰면 PID 1 이 `/bin/sh` 가 되는데, `sh` 는 그 시그널을 자식에게 전달하지 않습니다. 그러면 SDK 는 종료 요청을 **듣지 못하고**, 드레이닝은 시작조차 하지 않은 채 유예 시간이 지나 `SIGKILL` 이 옵니다. 진행 중이던 통화가 전부 그 자리에서 끊깁니다.

배포 설정을 아무리 맞춰도 이 층에서 막히면 무중단은 되지 않습니다.

```dockerfile
CMD ["node", "dist/app.js"]   # ✅ PID 1 = node — 시그널이 닿는다
```

```dockerfile
CMD node dist/app.js          # ⛔ PID 1 = /bin/sh — 시그널이 안 닿는다
```

```dockerfile
CMD ["npm", "start"]          # ⛔ PID 1 = npm — 앱이 드레이닝할 틈 없이 죽는다
```

`npm start` 는 셸 형식보다도 나쁩니다. npm 이 `SIGTERM` 을 받으면 자식 프로세스를 **곧바로** 죽여서, 유예 시간이 아무리 길어도 드레이닝이 시작되지 않습니다. 진입점에서는 런타임을 직접 부르세요.

지금 쓰는 이미지가 어느 쪽인지는 이렇게 확인합니다.

```bash
docker run -d --name check <이미지>
docker exec check cat /proc/1/cmdline | tr '\0' ' '
# node dist/app.js        → 괜찮습니다
# /bin/sh -c node ...     → 위 형식으로 고치세요
```

`CMD` 형식을 바꾸기 어렵다면 init 프로세스를 넣어도 됩니다 — Docker 는 `--init`, ECS 는 태스크 정의의 `initProcessEnabled: true`, Kubernetes 는 이미지에 `tini` 를 넣는 방식입니다.

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

HPA(오토스케일링)도 같은 이유로 이 번호에는 걸지 마세요.

Control 연결은 콜 알림만 주고받고 오디오는 통화별 Media WS로 흐르기 때문에, 인스턴스 하나가 감당하는 동시 통화 수는 대개 CPU와 사용하는 모델의 한도가 정합니다 — 연결 수가 아닙니다. 지금 규모에서 부족하다면 문의해 주세요.

번호를 여러 개 쓰신다면 **번호마다 인스턴스를 하나씩** 두는 것은 문제없습니다.
