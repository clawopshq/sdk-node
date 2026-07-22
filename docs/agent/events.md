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
  console.log(`통화 미연결: ${reason}`);
  // reason: "no-answer" / "busy" / "rejected" / "canceled" / "failed"
});
```

### 이벤트 목록

| 이벤트 | 파라미터 | 설명 |
|--------|----------|------|
| `call_start` | `(call)` | 통화 시작 — **상대가 받은 뒤** 미디어 세션이 열릴 때 |
| `call_end` | `(call)` | 통화 종료 — `call_start` 가 발화된 통화만 |
| `call_failed` | `(call, reason)` | 통화가 **연결되지 못하고** 종료됨. `reason` 은 종료 사유 |
| `transcript` | `(call, role, text)` | 음성 텍스트 생성 |
| `dtmf` | `(call, digit)` | DTMF 키 입력 수신 |

`call_start`/`call_end` 는 통화가 **응답된 뒤** 열리는 미디어 세션에 묶여 있습니다. 상대가 받지 않았거나
(무응답) 통화중·거절이면 이 두 이벤트는 발화되지 않고, 대신 **`call_failed` 가 발화**됩니다.
즉 발신 한 건은 반드시 `call_start`+`call_end` 또는 `call_failed` 중 한쪽으로 끝납니다.

| 결과 | 발화되는 이벤트 |
|------|-----------------|
| 상대가 받고 통화 종료 | `call_start` → `call_end` |
| 무응답 · 통화중 · 거절 · 취소 | `call_failed` |
| 연결됐으나 시스템 오류로 종료 | `call_start` → `call_end` + `call_failed`(`reason="failed"`) |

> `reason` 값은 `call.endedStatus` 와 동일합니다. 자세한 의미는
> [발신 결과 확인하기](quickstart.md#발신-결과-확인하기) 를 참고하세요.

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
| `status` | `CallStatus` | 수명주기 상태. 아래 표 참고 |
| `endedStatus` | `string \| null` | 종료 사유. 통화가 끝나기 전에는 `null` |
| `startTime` | `Date` | 통화 시작 시간 |
| `duration` | `number` | 통화 경과 시간 (초) |
| `metadata` | `Record<string, unknown>` | 사용자 정의 메타데이터 |

#### `status` — 수명주기

| 값 | 시점 |
|----|------|
| `ringing` | 세션 생성 직후 (발신·수신 공통) |
| `active` | 통화가 응답되어 미디어 세션이 열릴 때 |
| `ended` | **통화가 끝났을 때 — 응답 여부와 무관** |

#### `endedStatus` — 종료 사유

| 값 | 의미 |
|----|------|
| `completed` | 상대가 받았고 통화가 정상 종료됨 |
| `no-answer` | 벨은 울렸으나 받지 않음 (`timeout` 초과로 발신 취소) |
| `busy` | 통화중 |
| `rejected` | 상대가 거절 |
| `canceled` | 상대가 받기 전에 발신 측이 취소 |
| `failed` | 시스템/네트워크 오류 |

`status` 는 상대가 받았든 아니든 `ended` 가 되므로, **통화 성사 여부는 `endedStatus` 로 판단**합니다.
`completed` 만이 실제로 연결된 통화를 의미합니다.

```typescript
const session = await agent.call('01012345678');
await session.wait();
if (session.endedStatus !== 'completed') {
  console.log(`통화 미연결: ${session.endedStatus}`);
}
```

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
> 상대가 받지 않아도(무응답) 발신 취소 시점에 리턴하므로, **성사 여부는 리턴 후 `call.endedStatus` 로 확인**하세요.
