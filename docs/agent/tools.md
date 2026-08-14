# Tool (함수 호출)

`agent.tool()` 메서드로 AI가 호출할 수 있는 함수를 등록합니다.

## 기본 사용법

```typescript
agent.tool(
  'check_order',
  '주문 상태를 확인합니다. 고객이 주문 번호를 말하면 이 함수를 호출하세요.',
  { orderId: { type: 'string' } },
  async ({ orderId }) => {
    const order = await db.getOrder(orderId);
    return `주문 ${orderId}는 ${order.status} 상태입니다.`;
  },
);
```

## 작성 규칙

- 콜백 함수는 반드시 `async`여야 합니다
- 반환 타입은 `string`이어야 합니다
- **설명(description)이 AI에게 함수 설명으로 전달됩니다** — 상세하게 작성하세요
- 파라미터 스키마는 JSON Schema 형식으로 정의합니다

```typescript
agent.tool(
  'search_products',
  '상품을 검색합니다. 고객이 상품을 찾을 때 사용하세요.',
  {
    query: { type: 'string' }, // required
    category: { type: 'string' }, // required
    limit: { type: 'number' }, // required
  },
  async ({ query, category, limit }) => {
    const results = await productApi.search(query, category, limit ?? 10);
    return results.map((r) => `- ${r.name}: ${r.price}원`).join('\n');
  },
);
```

---

## Tool Config (도구 실행 설정)

`toolConfig`로 도구 실행 시 동작을 설정합니다.

```typescript
import { ClawOpsAgent } from 'clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  toolConfig: {
    holdAudio: true,
  },
});
```

### Hold Audio (대기 음악)

AI가 도구를 실행하는 동안 고객에게 대기 음악을 재생합니다. 외부 API 호출 등 시간이 걸리는 도구 실행 중 무음을 방지합니다.

| 값 | 설명 |
| :--- | :--- |
| `true` | 기본 차임 멜로디 재생 (~13초 루프) |
| `'./hold_music.wav'` | WAV 파일 경로 (16-bit PCM, 자동 리샘플링/모노 변환) |
| `Buffer` | raw µ-law 오디오 데이터 |
| `false` / 미설정 | 비활성화 **(기본값)** |

```typescript
// 기본 차임 사용
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  toolConfig: { holdAudio: true },
});

// 커스텀 WAV 파일
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  toolConfig: { holdAudio: './hold_music.wav' },
});
```

---

## 내장 Tool (Built-in Tools)

Agent는 통화 제어를 위한 내장 도구를 기본 제공합니다. `BuiltinTool`을 사용해 어떤 내장 도구를 활성화할지 제어할 수 있습니다.

### 내장 도구 목록

| 도구           | 상수                       | 설명                                                                           |
| :------------- | :------------------------- | :----------------------------------------------------------------------------- |
| `hang_up`       | `BuiltinTool.HANG_UP`       | 전화를 종료합니다. AI가 대화 완료를 판단하면 자동으로 호출합니다.              |
| `collect_dtmf`  | `BuiltinTool.COLLECT_DTMF`  | 사용자의 키패드(DTMF) 입력을 수집합니다. 본인 인증, 메뉴 선택 등에 사용합니다. |
| `send_dtmf`     | `BuiltinTool.SEND_DTMF`     | DTMF 신호를 전송합니다. ARS 메뉴 탐색, 내선번호 입력 등에 사용합니다.          |
| `transfer_call` | `BuiltinTool.TRANSFER_CALL` | 통화를 다른 번호로 전환합니다. Blind(즉시)와 Warm(안내 후) 모드를 지원합니다.   |

### 선택 상수

| 상수               | 설명                               |
| :----------------- | :--------------------------------- |
| `BuiltinTool.ALL`  | 모든 내장 도구 활성화 **(기본값)** |
| `BuiltinTool.NONE` | 모든 내장 도구 비활성화            |

### 사용법

```typescript
import { ClawOpsAgent, BuiltinTool } from 'clawops/agent';

// 기본: 모든 내장 도구 활성화
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
});

// 명시적으로 전부 활성화 (위와 동일)
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: BuiltinTool.ALL,
});

// 내장 도구 전부 비활성화 (커스텀 도구만 사용)
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: BuiltinTool.NONE,
});

// hang_up만 사용 (DTMF 도구 제외)
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: [BuiltinTool.HANG_UP],
});

// DTMF만 사용, hang_up 제외 (AI가 전화를 끊지 못하게)
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: [BuiltinTool.COLLECT_DTMF, BuiltinTool.SEND_DTMF],
});
```

### 활용 예시

**ARS 아웃바운드 봇** — 발신 후 ARS를 탐색해야 하므로 `SEND_DTMF`만 필요:

```typescript
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: [BuiltinTool.HANG_UP, BuiltinTool.SEND_DTMF],
});
```

**고객 인증 봇** — 고객이 주민번호 뒤 자리를 키패드로 입력:

```typescript
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: [BuiltinTool.HANG_UP, BuiltinTool.COLLECT_DTMF],
});
```

**고객센터 봇** — AI가 1차 응대 후 상담원으로 전환:

```typescript
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: [BuiltinTool.HANG_UP, BuiltinTool.TRANSFER_CALL],
});
```

---

## Call Transfer (통화 전환)

`transfer_call` 내장 도구를 활성화하면 AI가 대화 중 다른 번호로 통화를 전환할 수 있습니다.
코드에서 직접 `call.transfer()`를 호출할 수도 있습니다.

### Blind Transfer (즉시 전환)

고객을 대상 번호로 바로 연결합니다. 전환이 시작되면 AI 세션은 종료됩니다.

```typescript
await call.transfer('01012345678');
```

### Warm Transfer (안내 후 전환)

대상이 전화를 받으면 whisper 메시지를 먼저 들려준 후 고객과 연결합니다.
고객은 whisper를 들을 수 없으며, 연결 대기 중에는 대기 음악이 재생됩니다.

```typescript
await call.transfer('01012345678', {
  mode: 'warm',
  whisper: 'VIP 고객님이십니다. 주문 번호는 A1234입니다.',
});
```

### 전환 후 AI 복귀

전환된 통화가 끝나면 AI가 다시 고객과 대화를 이어갑니다.
예를 들어 전문 상담원과 통화 후 AI가 후속 안내를 하는 시나리오에 적합합니다.

```typescript
await call.transfer('01012345678', {
  afterTransfer: 'return', // 기본값: 'terminate'
});
```

### SIP 엔드포인트 전환

전화번호(PSTN) 대신 SIP 엔드포인트로 통화를 직접 전환합니다.
PSTN 통신사를 거치지 않고 SIP URI(`sip:user@host`)로 INVITE 브릿지합니다 (녹음·관측 유지).

```typescript
await call.transfer('sip:agent@sip.example.com', {
  destinationType: 'sip', // 기본값: 'pstn' (전화번호 전환)
});
```

> **`sip_trunk` 부가서비스가 필요합니다.** 부가서비스가 없는 계정이 SIP 전환을 시도하면
> 전환은 실패하고(`{ status: 'failed' }`) 통화는 끊기지 않은 채 AI가 계속 응대합니다.
> 인바운드 BYOC/softphone 라우팅과 동일한 게이트입니다.

### Context 전달

전환 대상에게 고객 정보 등 구조화 데이터를 webhook으로 전달할 수 있습니다.

```typescript
await call.transfer('01012345678', {
  mode: 'warm',
  whisper: 'VIP 고객입니다.',
  holdMedia: 'moh',        // 전환 중 고객에게 ('moh' | 'ringback' | 'silence')
  context: {
    customerName: '홍길동',
    orderId: 'ORD-20260325-001',
    priority: 'high',
  },
});
```

### 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|:---------|:-----|:-------|:-----|
| `to` | `string` | (필수) | 전환 대상. `destinationType: 'pstn'`이면 전화번호, `'sip'`이면 SIP URI(`sip:user@host`) |
| `destinationType` | `string` | `'pstn'` | `'pstn'`: 통신사 경유 전화번호 전환, `'sip'`: SIP 엔드포인트 직접 전환 (**`sip_trunk` 부가서비스 필요**) |
| `mode` | `string` | `'blind'` | `'blind'`: 즉시 전환, `'warm'`: whisper 후 전환 |
| `afterTransfer` | `string` | `'terminate'` | `'terminate'`: AI 세션 종료, `'return'`: 전환 통화 종료 후 AI가 다시 대화를 이어감 |
| `holdMedia` | `string` | `'ringback'` | 전환 중 고객에게 재생할 대기 음원. `'moh'`: 대기 음악, `'ringback'`: 통화 연결음, `'silence'`: 무음 |
| `whisper` | `string` | `undefined` | Warm 모드에서 대상이 전화를 받았을 때 전달할 안내 메시지 (TTS). 고객에게는 들리지 않음 |
| `context` | `object` | `undefined` | 전환 대상에게 webhook으로 전달할 구조화 데이터 (예: 고객 정보, 주문 번호 등) |
| `callerIdMode` | `string` | `undefined` | 전환받는 쪽에 표시할 번호를 **의도**로 지정. `'account'`: 계정 번호(기본과 같음), `'original'`: 원 발신자 승계 |
| `callerId` | `string` | `undefined` | 표시할 번호를 **직접** 지정. 허용 범위를 벗어나면 전환이 실패합니다 (아래 참고) |
| `timeout` | `number` | `30` | 대상 응답 대기 시간 (초). 초과 시 전환 실패 처리 |

### 전환받는 쪽에 표시되는 발신번호

**기본값은 계정이 보유한 번호입니다.** 인바운드 통화를 전환하면 그 통화를 받은 번호(예: 070)가
표시됩니다. 직원 전화에는 "우리 대표번호에서 걸려온 전화"로 보입니다.

원 발신자(전화를 건 고객)의 번호를 그대로 보이게 하려면 `callerIdMode: 'original'` 을 씁니다.

```typescript
await call.transfer('021234567', { callerIdMode: 'original' });
```

`callerIdMode` 와 `callerId` 는 성격이 다릅니다.

| | 성격 | 승계·검증에 실패하면 |
|:--|:--|:--|
| `callerIdMode: 'original'` | **선호** | 계정 번호로 내려앉고 **전환은 성사됩니다** |
| `callerId: '01012345678'` | **지시** | `UNOWNED_CALLER_ID` 로 **전환 자체가 실패합니다** |

원 발신자 번호는 다음 경우에 승계할 수 없습니다. 이때 `callerIdMode: 'original'` 은 조용히
계정 번호로 돌아가고, `callerId` 로 같은 번호를 직접 넘겼다면 전환이 실패합니다.

- 통신사 직결로 들어온 인바운드가 아닌 경우 (착신전환·중계 경로로 들어온 통화)
- 발신번호가 국내 번호로 정규화되지 않는 경우 (국제전화, 표시 제한 등)
- 아웃바운드 통화 (원 발신자라는 개념이 없어 무시됩니다)

`callerId` 로 직접 지정할 수 있는 번호는 **계정이 보유한 번호**이거나 **그 통화의 원 발신자**
뿐입니다. 그 외 번호는 발신번호 변작 방지를 위해 거절됩니다. 둘 다 지정하면 `callerId` 가
이기고 `callerIdMode` 는 무시됩니다.

> VoiceML `<Dial>` 은 기본값이 다릅니다 — 통신사 직결 인바운드면 **원 발신자를 기본으로 승계**합니다.
> 같은 의도라도 표면에 따라 기본 동작이 다르니, 두 방식을 함께 쓴다면 명시적으로 지정하세요.

**단순 안내 봇** — 통화 종료만 가능하면 충분:

```typescript
const agent = new ClawOpsAgent({
  from: '07012341234',
  session,
  builtinTools: [BuiltinTool.HANG_UP],
});
```
