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

agent.on('call_failed', async (call, reason) => {
  console.log(`발신 실패: ${reason}`);
});
```

### 이벤트 목록

| 이벤트 | 파라미터 | 설명 |
|--------|----------|------|
| `call_start` | `(call)` | 통화 시작 |
| `call_end` | `(call)` | 통화 종료 |
| `call_failed` | `(call, reason)` | 발신 실패 |
| `transcript` | `(call, role, text)` | 음성 텍스트 생성 |

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
| `status` | `string` | `queued`, `ringing`, `in-progress`, `completed`, `failed`, `no-answer`, `busy` |
| `startTime` | `Date` | 통화 시작 시간 |
| `duration` | `number` | 통화 경과 시간 (초) |
| `metadata` | `Record<string, unknown>` | 사용자 정의 메타데이터 |

### 메서드

```typescript
agent.on('call_start', async (call) => {
  call.metadata.customerId = 'CUST_123';

  await call.sendAudio(pcm16Bytes);   // 오디오 전송
  await call.clearAudio();            // 오디오 큐 초기화 (인터럽트 시)
  await call.hangup();                // 통화 종료
  await call.wait();                  // 통화 종료까지 대기 (아웃바운드 시 유용)
});
```

> `await call.wait()`는 통화가 종료되어 `status`가 `completed`로 변경될 때까지 대기합니다. 주로 아웃바운드 단건 발신 시 통화 완료를 기다리는 데 사용합니다.
