# 이벤트 & CallSession

## 이벤트 핸들러

`agent.on()` 메서드로 통화 이벤트를 수신합니다.

```typescript
agent.on('call_start', async (call) => {
  console.log(`통화 시작: ${call.fromNumber} -> ${call.toNumber}`);
  console.log(`통화 ID: ${call.callId}`);
});

agent.on('call_end', async (call) => {
  console.log(`통화 종료: ${call.callId} (총 ${call.duration.toFixed(1)}초)`);
});

agent.on('transcript', async (call, role, text) => {
  console.log(`[${role}] ${text}`);
  // role: "user" (고객 음성 인식) 또는 "assistant" (AI 응답)
});
```

### 이벤트 목록

| 이벤트 | 파라미터 | 설명 |
|--------|----------|------|
| `call_start` | `(call)` | 통화 시작 — **상대가 받은 뒤** 미디어 세션이 열릴 때 |
| `call_end` | `(call)` | 통화 종료 — `call_start` 가 발화된 통화만 |
| `transcript` | `(call, role, text)` | 음성 텍스트 생성 |
| `dtmf` | `(call, digit)` | DTMF 키 입력 수신 |

> **주의 — 연결되지 않은 통화에서는 아무 이벤트도 발화되지 않습니다.**
> `call_start`/`call_end` 는 통화가 **응답된 뒤** 열리는 미디어 세션에 묶여 있습니다. 상대가 받지 않았거나
> (무응답) 통화중·거절이면 두 이벤트 모두 발화되지 않고, `await call.wait()` 만 조용히 리턴합니다.
>
> SDK 에 `call_failed` 이벤트 타입이 정의되어 있지만 **현재 서버는 이 이벤트를 보내지 않습니다.**
> 핸들러를 등록해도 호출되지 않으니 발신 실패 감지에 사용하지 마세요.
> 발신 결과는 [발신 결과 확인하기](quickstart.md#발신-결과-확인하기) 를 참고하세요.

## CallSession

개별 통화의 상태를 관리합니다. 이벤트 핸들러의 `call` 파라미터로 전달됩니다.

### 속성

| 속성 | 타입 | 설명 |
|------|------|------|
| `callId` | `string` | 통화 ID |
| `fromNumber` | `string` | 발신 번호 |
| `toNumber` | `string` | 수신 번호 |
| `accountId` | `string` | 계정 ID |
| `direction` | `string` | `"inbound"` 또는 `"outbound"` |
| `status` | `CallStatus` | `'ringing'` \| `'active'` \| `'ended'` — 아래 표 참고 |
| `startTime` | `Date` | 통화 시작 시간 |
| `duration` | `number` | 통화 경과 시간 (초) |
| `metadata` | `Record<string, unknown>` | 사용자 정의 메타데이터 |

#### `status` 값

| 값 | 시점 |
|----|------|
| `ringing` | 세션 생성 직후 (발신·수신 공통) |
| `active` | 통화가 응답되어 미디어 세션이 열릴 때 |
| `ended` | **통화가 끝났을 때 — 응답 여부와 무관** |

> **주의:** `status` 는 SDK 내부 진행 상태이며 최종 결과가 아닙니다. 상대가 받지 않아 무응답으로 끝난 통화도
> `ended` 가 됩니다. `no-answer` / `busy` / `rejected` 같은 실제 종료 사유는
> [발신 결과 확인하기](quickstart.md#발신-결과-확인하기) 를 참고하세요.

### 메서드

```typescript
agent.on('call_start', async (call) => {
  call.metadata.customerId = 'CUST_123';

  await call.sendAudio(pcm16Bytes);   // 오디오 전송
  await call.clearAudio();            // 오디오 큐 초기화 (인터럽트 시)
  await call.hangup();                // 통화 종료
  await call.transfer('01012345678'); // 다른 번호로 통화 전환
  await call.wait();                  // 통화 종료까지 대기 (아웃바운드 시 유용)
});
```

> `await call.wait()`는 통화가 종료될 때까지 대기합니다. 주로 아웃바운드 단건 발신 시 통화가 끝나기를 기다리는 데 사용합니다.
> **상대가 받지 않아도(무응답) 발신 취소 시점에 리턴하며, 리턴했다는 사실만으로는 통화 성사 여부를 알 수 없습니다.**
