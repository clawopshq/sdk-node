# ClawOps Node.js SDK

[ClawOps Voice API](https://api.claw-ops.com/docs)의 공식 Node.js/TypeScript 라이브러리입니다.

[![npm version](https://img.shields.io/npm/v/@teamlearners/clawops.svg)](https://www.npmjs.com/package/@teamlearners/clawops)
[![Node.js 18+](https://img.shields.io/node/v/@teamlearners/clawops.svg)](https://www.npmjs.com/package/@teamlearners/clawops)

## 설치

```bash
# REST API SDK만 사용
npm install @teamlearners/clawops

# AI Agent 포함 (필요한 프로바이더를 함께 설치)
npm install @teamlearners/clawops ws openai                          # OpenAI Realtime 모드
npm install @teamlearners/clawops ws @google/genai                   # Gemini Realtime 모드
npm install @teamlearners/clawops ws @deepgram/sdk openai elevenlabs # Pipeline 모드 (OpenAI LLM)
npm install @teamlearners/clawops ws @deepgram/sdk @anthropic-ai/sdk elevenlabs # Pipeline 모드 (Anthropic LLM)
```

## AI Agent (음성 에이전트)

`ClawOpsAgent`를 사용하면 한 줄로 인바운드 전화를 AI로 처리할 수 있습니다. ngrok 없이 WebSocket 역방향 연결로 동작합니다.

```typescript
import { ClawOpsAgent, OpenAIRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '친절한 상담원입니다. 고객의 질문에 답변해주세요.',
    voice: 'marin',
    language: 'ko',
  }),
});

agent.tool('check_order', '주문 상태를 확인합니다.', { orderId: { type: 'string' } }, async ({ orderId }) => {
  return '배송 완료';
});

agent.on('call_start', async (call) => {
  console.log(`통화 시작: ${call.fromNumber} -> ${call.toNumber}`);
});

await agent.serve(); // Ctrl+C로 종료
```

### Outbound 발신 Prewarm (낮은 첫 음성 latency)

outbound 통화에서 상대 응답 직후 첫 음성까지의 지연을 줄이기 위해, `ClawOpsAgent` 는
control WS 의 `call.outbound_ready` 이벤트 수신 즉시 LLM WebSocket 을 미리 연결하고
첫 audio delta 를 메모리에 누적한다 (prewarm + first-audio prebuffer). media WS 가 연결되면
누적된 chunk 를 flush 하여 사용자가 첫 음성을 빠르게 듣게 한다.

```typescript
const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({ systemPrompt: '...' }),
  prewarmEnabled: true, // default true
});
```

비용/효과 검증 단계에서는 `prewarmEnabled: false` 로 비활성화할 수 있다. 동작 측정은
`[PREWARM-T]` 로그 마커(`start` / `done` / `failed` / `attach` / `first-audio`)를 grep
하여 elapsed 를 계산한다.

**한계 / 비목표**

- **동시 outbound 통화 1건 가정** — `ClawOpsAgent` 1 인스턴스의 `session` 객체는 prewarm 시
  단일 `BufferingCall` 을 공유한다. 같은 인스턴스로 동시 outbound 통화를 발신하면 prewarm
  race 가 발생할 수 있다. 다중 동시 outbound 가 필요하면 통화별로 별도 `ClawOpsAgent`
  인스턴스를 사용하거나, session factory 패턴 도입이 필요하다 (후속 과제).
- **Session 타입별 효과 차이** — Realtime (OpenAI / Gemini) 에서 LLM WS handshake +
  session.update 가 prewarm 으로 숨겨지므로 latency 절감 효과가 가장 크다. 반면
  `PipelineSession` 은 STT / LLM / TTS 가 lazy 연결되므로, prewarm 단계에서는 STT 루프
  기동과 greeting kickoff 정도만 선행되어 latency 절감 효과가 제한적이다.

### Call Transfer (통화 전환)

AI가 통화 중 다른 번호로 전환할 수 있습니다. Blind(즉시)와 Warm(안내 후) 모드를 지원합니다.

```typescript
import { ClawOpsAgent, OpenAIRealtime, BuiltinTool } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '고객 문의를 처리하고, 필요하면 상담원에게 전환하세요.',
  }),
  builtinTools: [BuiltinTool.HANG_UP, BuiltinTool.TRANSFER_CALL],
});

// 코드에서 직접 전환도 가능
agent.on('call_start', async (call) => {
  if (shouldTransfer) {
    await call.transfer('01012345678', { mode: 'warm', whisper: 'VIP 고객입니다.' });
  }
});

await agent.serve();
```

### MCP 서버 연동

MCP 서버를 연결하여 AI에게 외부 도구를 제공할 수 있습니다.

```bash
npm install @teamlearners/clawops ws @modelcontextprotocol/sdk
```

```typescript
import { ClawOpsAgent, OpenAIRealtime, mcpServerStdio, mcpServerHTTP } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '상담원입니다.',
  }),
  mcpServers: [
    mcpServerStdio('npx', { args: ['@modelcontextprotocol/server-google'], env: { GOOGLE_API_KEY: '...' } }),
    mcpServerHTTP('https://my-mcp-server.com', { headers: { Authorization: 'Bearer token' } }),
  ],
});

await agent.serve(); // Ctrl+C로 종료
```

MCP 서버는 전화가 올 때마다 자동으로 시작되고, 통화 종료 시 정리됩니다. MCP 서버가 제공하는 도구는 `agent.tool()`로 등록한 도구와 함께 세션에 자동 등록됩니다.

### OpenTelemetry Tracing

통화 흐름, MCP 도구 호출, LLM 세션을 OpenTelemetry로 추적할 수 있습니다.

```bash
npm install @teamlearners/clawops ws @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-grpc
```

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
provider.register();

import { ClawOpsAgent, OpenAIRealtime, setTracingConfig } from '@teamlearners/clawops/agent';

setTracingConfig({ enabled: true, serviceName: 'my-call-center' });

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({ systemPrompt: '상담원입니다.' }),
});
```

**Span 계층:**
- `call` → `mcp.connect` → `llm.session` → `tool.call` → `mcp.call_tool`

> 자세한 사용법은 **[Agent 문서](docs/agent/)** 를 참고하세요. (Tool, 이벤트, 통화 녹음, 파이프라인 모드, 커스텀 제공자, MCP 연동, Tracing 등)

## REST API 사용법

```typescript
import ClawOps from '@teamlearners/clawops';

const client = new ClawOps({
  apiKey: 'sk_...',          // 또는 CLAWOPS_API_KEY 환경변수 사용
  accountId: 'AC1a2b3c4d',   // 또는 CLAWOPS_ACCOUNT_ID 환경변수 사용
});
```

### 통화 (Calls)

```typescript
// 발신 전화 생성
const call = await client.calls.create({
  to: '01012345678',
  from: '07052358010',
  url: 'https://my-app.com/twiml',
  statusCallback: 'https://my-app.com/status',
  statusCallbackEvent: 'initiated ringing answered completed',
});
console.log(call.callId);

// 음성사서함 감지(AMD) — Enable=결과만 통보(통화 계속), Hangup=사서함이면 자동 종료
const amdCall = await client.calls.create({
  to: '01012345678',
  from: '07052358010',
  url: 'https://my-app.com/twiml',
  machineDetection: 'Enable',
});
// 통화 종료 후 결과 확인: human(사람) / machine(자동응답기) / unknown(판정 불가)
const done = await client.calls.get(amdCall.callId);
console.log(done.answeredBy);
// statusCallback 을 설정했다면 completed 이벤트 payload 의 AnsweredBy 로도 통보됩니다.

// 통화 목록 조회 (페이지네이션)
const page = await client.calls.list({ status: 'completed', page: 0, pageSize: 20 });
for (const call of page) {
  console.log(call.callId, call.status);
}

// 모든 통화를 자동으로 순회
for await (const call of (await client.calls.list()).autoPagingIter()) {
  console.log(call.callId);
}

// 특정 통화 조회
const detail = await client.calls.get('CAabcdef1234567890');

// 연결 실패 사유 확인 — status가 'failed' 인 경우는 결번·망 오류·시스템 오류를 모두 포함하는
// 대분류라, 다시 걸어도 소용없는 번호를 가려내려면 hangupCause 를 봅니다.
const DO_NOT_RETRY = ['invalid_number', 'number_changed', 'incompatible_destination'];
if (detail.status !== 'completed') {
  if (DO_NOT_RETRY.includes(detail.hangupCause ?? '')) {
    console.log(`결번 — 목록에서 제외: ${detail.to}`); // hangupCauseQ850=1, sipResponseCode=404
  } else if (detail.hangupSource === 'app' || detail.hangupSource === 'system') {
    console.log('ClawOps 측 오류 — 재시도');
  } else {
    console.log(`일시적 사유(${detail.hangupCause}) — 나중에 재시도`);
  }
}

// 통화 종료
await client.calls.update('CAabcdef1234567890', { status: 'completed' });

// 통화 전사 상태 조회 (completed 시 segments 까지 inline)
const state = await client.calls.getTranscript('CAabcdef1234567890');
if (state.status === 'completed') {
  for (const seg of state.segments ?? []) {
    console.log(`[${seg.speaker}] ${seg.text}`);
  }
} else if (state.status === 'not_requested') {
  // 조직 설정 off 거나 아직 요청 안 된 상태 — 명시 요청 (사용량 과금)
  await client.calls.requestTranscript('CAabcdef1234567890');
}

// 통화 요약 상태 조회 (completed 시 resultJson 까지 inline)
const summary = await client.calls.getSummary('CAabcdef1234567890');
if (summary.status === 'completed') {
  console.log(summary.resultJson); // { coreSummary, decisions, followUps, sentiment }
}
```

### 통화 녹음 (Recordings)

콘솔에서 들리는 것과 동일한 서버측 MixMonitor 원본(WAV PCM 16bit mono 8kHz)을 다운로드합니다. SDK 측 mix.wav가 아닌 서버에서 합성된 파일이라 싱크/볼륨이 정상입니다.

```typescript
import { writeFile } from 'node:fs/promises';

// callList 응답의 recordingUrl 필드로 녹음 유무 확인 가능
const list = await client.calls.list({ pageSize: 10 });
for (const call of list.data) {
  if (!call.recordingUrl) continue; // failed/no-answer 등은 null
  const rec = await client.recordings.download(call.callId);
  await writeFile(rec.filename ?? `${call.callId}.wav`, Buffer.from(rec.data));
  console.log(rec.contentType, rec.data.byteLength, 'bytes');
}
```

녹음이 없는 통화(`recordingUrl: null`)에 호출하면 `NotFoundError(404)` 가 발생합니다.

```typescript
// 녹음 삭제 (멱등 — 이미 없어도 성공)
await client.recordings.delete('CAabcdef1234567890');
```

### 전화번호 (Numbers)

```typescript
// 번호 발급 — 풀에서 자동 배정되며 어떤 번호가 나올지는 지정할 수 없다
const number = await client.numbers.create();
console.log(number.number, number.routingType); // 07012340001 webhook

// 번호 목록 조회 (페이지네이션 없음 — 보유한 번호가 전부 반환된다)
const numbers = await client.numbers.list();

// 발급 직후에는 webhookUrl 이 비어 있어 걸려온 전화가 거절된다. 착신 라우팅을 지정한다.

// 매니지드 에이전트가 받도록
await client.numbers.update('07012340001', {
  routingType: 'agent',
  agentId: 'AG7c2f9b1e4a6d',
});

// 콜 플로우(ARS)가 받도록
await client.numbers.update('07012340001', {
  routingType: 'callflow',
  callFlowId: 'CF41b8e07d9c25',
});

// 내 서버의 VoiceML 이 받도록
await client.numbers.update('07012340001', {
  routingType: 'webhook',
  webhookUrl: 'https://my-app.com/voice',
});

// 보유한 다른 번호로 착신전환 (같은 계정의 번호만 가능)
await client.numbers.update('07012340001', {
  routingType: 'forward',
  forwardTo: '07012340002',
});

// 소프트폰 단말 착신 (sip_trunk 부가서비스 + 등록 단말 필요)
const creds = await client.sipCredentials.list({ status: 'active' });
await client.numbers.update('07012340001', {
  routingType: 'softphone',
  sipCredentialId: creds[0].id,
});

// 외부 PBX 로 (sip_trunk 부가서비스 + 활성 라우트 1개 이상 필요)
const endpoints = await client.sipEndpoints.list({ status: 'active' });
await client.numbers.update('07012340001', { routingType: 'sip', sipEndpointId: endpoints[0].id });

// 수신 통화 상태 통지
await client.numbers.update('07012340001', {
  statusCallback: 'https://my-app.com/call-status',
  statusCallbackEvents: 'initiated ringing answered completed',
});

// 번호 반납 — 되돌릴 수 없고 같은 번호를 다시 받는다는 보장이 없다
await client.numbers.delete('07012340001');
```

라우팅을 바꾸면 다른 라우팅 필드는 서버에서 자동으로 비워집니다. `agent` 에서 `webhook` 으로
되돌리면 `agentId` 가 `null` 이 되므로, 다시 `agent` 로 돌아갈 때 `agentId` 를 새로 지정해야
합니다.

### 메시지 (Messages)

```typescript
// SMS 발송
const msg = await client.messages.create({
  to: '01012345678',
  from: '07052358010',
  body: '안녕하세요',
});
console.log(msg.messageId);

// MMS 발송
const mms = await client.messages.create({
  to: '01012345678',
  from: '07052358010',
  body: '사진 첨부',
  type: 'mms',
  subject: '제목',
});

// LMS (장문 문자) 발송
const lms = await client.messages.create({
  to: '01012345678',
  from: '07052358010',
  body: '긴 내용의 메시지입니다...',
  type: 'lms',
  subject: '알림',
});

// 메시지 목록 조회 (필터링)
const msgPage = await client.messages.list({ type: 'sms', status: 'sent', page: 0, pageSize: 20 });
for (const m of msgPage) {
  console.log(m.messageId, m.status);
}

// 모든 메시지를 자동으로 순회
for await (const m of (await client.messages.list()).autoPagingIter()) {
  console.log(m.messageId);
}

// 특정 메시지 조회
const detail = await client.messages.get('MG0123456789abcdef');
```

### 카카오 알림톡 (Kakao)

승인된 템플릿으로 알림톡을 보냅니다. 발송에 필요한 채널·템플릿 ID 는 SDK 로 조회합니다.

```typescript
// 1. 연결된 카카오 채널
const channels = await client.kakao.channels.list({ status: 'connected' });
const channel = channels.data[0];

// 2. 그 채널의 템플릿 — sendable: true 인 것만 보낼 수 있습니다
const templates = await client.kakao.templates.list({ channelId: channel.id });
const template = templates.data.find((t) => t.sendable);
console.log(template.variables); // ['#{고객명}'] — 이 목록을 모두 채워야 합니다

// 3. 발송
const msg = await client.messages.create({
  to: '01012345678',
  from: '07052358010',
  kakao: {
    channelId: channel.id,
    templateId: template.id,
    variables: { 고객명: '홍길동' }, // '#{고객명}' 표기도 받습니다
  },
  fallback: { body: '주문이 접수되었습니다.' },
});
console.log(msg.type); // 'ata'
```

**본문은 템플릿이 정합니다.** 알림톡에는 `body`·`subject`·`mediaUrl` 을 실을 수 없고(컴파일
에러입니다), 버튼·아이템 리스트·강조 문구는 카카오 검수를 받은 그대로 나갑니다 — 발송 요청으로
바꿀 수 없습니다. 요청에서 바꿀 수 있는 것은 `variables` 값뿐입니다.

**대체발송(`fallback`)은 별도의 메시지 1건으로 기록되고 문자 단가로 청구됩니다.** 생략하면
템플릿 본문이 그대로 문자로 나가고, `fallback: { disabled: true }` 면 알림톡 실패가 그대로
실패로 남습니다.

변수를 빠뜨리면 발송 전에 `400 kakao_variable_missing` 으로 막힙니다(카카오는 이런 요청도
접수한 뒤 조용히 실패시키므로 ClawOps 가 미리 잡습니다). 사유는 `e.code` 로 분기하세요.

#### 채널 연결

채널 연결은 두 단계입니다 — 인증번호는 카카오 비즈니스에 등록된 **담당자 휴대전화로만** 갑니다.

```typescript
const categories = await client.kakao.channelCategories();

const requested = await client.kakao.channels.requestToken({
  searchId: '@example',
  phoneNumber: '010-1234-5678',
});
console.log(requested.phoneNumberMasked); // '010-****-5678'

// 담당자가 받은 인증번호로 완료 (이미 연결된 채널이면 인증번호를 쓰지 않고 기존 연결을 돌려줍니다)
const channel = await client.kakao.channels.connect({
  searchId: requested.searchId,
  phoneNumber: '010-1234-5678',
  categoryCode: categories.data[0].code,
  token: '394812',
});
```

⚠️ `connect()` 가 **타임아웃되면 재호출하지 마세요.** 이미 연결에 성공했을 수 있습니다 —
`channels.retrieve(id)` 로 실제 등록 여부를 확인하세요(이 조회는 몇 번을 불러도 안전합니다).
연결에 **실패해도 인증번호는 소모되므로** 원인을 해결한 뒤 `requestToken()` 부터 다시 시작해야 합니다.

⚠️ `channels.disconnect(id)` 는 **되돌릴 수 없고 그 채널의 알림톡 템플릿까지 함께 삭제합니다.**
템플릿은 카카오 검수를 다시 받아야 합니다.

`channels.list()` 는 저장된 연결 정보를 그대로 돌려줍니다(빠릅니다). 카카오 쪽 상태까지 실제로
확인하는 것은 `channels.retrieve()` 뿐이며, 이 호출이 `status` 를 갱신합니다.

### 솔라피(SOLAPI) 호환 — 문자만 ClawOps 로

이미 솔라피 SDK 로 작성된 코드를 **그대로 두고** 문자(SMS/LMS/MMS)만 ClawOps 로 보냅니다.
알림톡·친구톡·RCS 는 기존 솔라피 계정으로 계속 나갑니다.

```bash
npm install @teamlearners/clawops solapi
```

바꾸는 곳은 **인스턴스를 만드는 한 줄**뿐입니다.

```typescript
import { ClawOps } from '@teamlearners/clawops';
import { ClawOpsMessageService } from '@teamlearners/clawops/solapi';
import { SolapiMessageService } from 'solapi';

const messageService = new ClawOpsMessageService({
  clawops: new ClawOps({ apiKey: process.env.CLAWOPS_API_KEY, accountId: process.env.CLAWOPS_ACCOUNT_ID }),
  solapi: new SolapiMessageService(SOLAPI_KEY, SOLAPI_SECRET), // 알림톡을 계속 쓸 때만
  from: '07052358010',                                          // ClawOps 에 등록된 번호
});

// 이 아래 호출부는 기존 코드 그대로입니다
await messageService.send({ to: '01012345678', from: '07052358010', text: '인증번호는 123456 입니다' });
```

`messageService` 의 타입은 `SolapiMessageService` 와 동일해서 기존 코드의 타입 자리에 그대로 들어갑니다.
`send` 만 가로채고 `getBalance()`·`getKakaoChannels()` 같은 나머지 메서드는 주입한 솔라피 인스턴스로 그대로 전달합니다.
원본 인스턴스는 수정하지 않습니다.

| 메시지 | 어디로 |
|---|---|
| `SMS` / `LMS` / `MMS` | **ClawOps** |
| `ATA`(알림톡) · `CTA`/`CTI`(친구톡) · `RCS_*` · `NSA` · `FAX` · `VOICE` · `BMS_*` | 솔라피 (요청을 손대지 않고 그대로 전달) |
| `type` 미지정 | `kakaoOptions`·`rcsOptions` 같은 **vendor 옵션이 있으면 솔라피**, 없으면 ClawOps |

솔라피는 `type` 을 필수로 요구하지 않고 vendor 옵션으로 추론합니다. 그래서 우리도 타입 문자열이
아니라 **실제로 실린 옵션**으로 가릅니다 — `send({ to, from, kakaoOptions })` 처럼 `type` 을 생략한
알림톡도 솔라피로 갑니다.

`type` 을 `SMS`/`LMS` 로 지정하면 그대로 따르고, 지정하지 않고 vendor 옵션도 없으면 서버와 같은
규칙으로 고릅니다 — `subject` 가 있으면 `lms`, 본문이 **EUC-KR 90 byte(한글 45자)** 를 넘으면
`lms`, 아니면 `sms`. **솔라피의 SMS 기준과 같습니다**(솔라피 상태코드 `1029`·`1031`).
기존 분기 로직을 그대로 옮기셔도 됩니다.

⚠️ `type: 'SMS'` 로 **명시**한 본문이 90 byte 를 넘으면 ClawOps 는 `400` 으로 거절합니다.
통신사는 이런 본문을 거절하지 않고 **90 byte 에서 잘라서 보내므로**, 잘린 문자가 나가는 대신
에러를 돌려줍니다. 길이가 런타임에 정해진다면 `type` 을 생략하십시오 — 알아서 `lms` 로 올라갑니다.

`imageId` 는 솔라피에 업로드된 파일 ID 라 ClawOps 로 옮길 수 없습니다. 이미지가 붙은 메시지는
조용히 텍스트만 보내지 않고 **에러를 던집니다**. 첨부가 필요하면 `client.messages.create` 의
`mediaUrl` 로 직접 발송하십시오. 첨부 없는 `MMS` 는 위 규칙에 따라 `sms`/`lms` 로 나갑니다.

거절은 모두 `SolapiBridgeError`(`ClawOpsError` 하위)로 던지므로 SDK 의 다른 에러와 함께 잡을 수 있습니다.

#### 알림톡 실패 시 문자로 대체발송

솔라피의 대체발송은 **솔라피에 등록된 발신번호**가 있어야 동작합니다. 그 번호가 없으면
알림톡이 실패해도 문자가 나가지 않습니다. 이때 대체발송을 ClawOps 가 대신합니다.

의도는 솔라피 API 의 값 그대로 읽습니다 — 별도 옵션이 필요 없습니다.

| 보낸 값 | 동작 |
|---|---|
| `from` 있음 + `disableSms` 생략/`false` | 알림톡 실패 시 **ClawOps 문자로 대체발송** |
| `disableSms: true` | 대체발송하지 않음 |
| `from` 없음 | 대체발송하지 않음 (솔라피 규칙과 동일) |

솔라피로 요청을 넘길 때 두 가지를 조정합니다.

- `from` 을 **제외**합니다. 솔라피에 등록되지 않은 번호가 실리면 알림톡 자체가 접수 거부됩니다.
- `disableSms` 를 `true` 로 보냅니다. 솔라피가 중복으로 문자를 발송하지 않도록.

대체발송 문구는 다음 순서로 정해집니다.

1. `customFields` 에 지정한 문구 (기본 키 `clawopsFallbackText`) — 문자 전용 문구를 직접 넣을 때
2. **`kakaoOptions.templateId` 가 있으면** 그 템플릿 본문을 조회해 `variables` 로 치환 — 알림톡은 보통 `text` 없이 보내므로 기본 경로입니다. `type` 을 생략해도 동작합니다
3. 그 밖에는 `text` 가 본문입니다

```typescript
await messageService.send({
  to: '01012345678',
  from: '07052358010',
  type: 'ATA',
  kakaoOptions: { pfId: 'KA01PF...', templateId: 'TPL_001', variables: { 고객명: '홍길동', 주문번호: 'A-1024' } },
  // 문자로 나갈 때만 다른 문구를 쓰고 싶다면
  customFields: { clawopsFallbackText: '[상점명] 홍길동님 주문 A-1024 가 접수되었습니다.' },
});
```

치환되지 않은 변수(`#{...}`)가 남으면 **발송하지 않고** `onBlocked` 로 알립니다.
`#{주문번호}` 가 그대로 찍힌 문자가 나가는 것을 막기 위해서입니다.

```typescript
const messageService = new ClawOpsMessageService({
  clawops, solapi, from: '07052358010',
  fallback: {
    enabled: true,                         // 기본 true. false 면 대체발송하지 않는다
    field: 'clawopsFallbackText',          // customFields 키를 바꾸고 싶을 때
    onFallback: (e) => logger.info({ to: e.to, source: e.source }, '문자로 대체발송'),
    onBlocked:  (e) => logger.warn({ to: e.to, reason: e.reason }, '대체발송 못 함'),
  },
});
```

대체발송된 건은 솔라피와 같은 의미로 `groupInfo.count.sentReplacement` 에 집계됩니다.

#### 발송 실패(3XXX)까지 대체발송 — `mode: 'sweep'`

위까지는 **접수 실패**만 다룹니다. 그런데 실제로 대체발송이 필요한 건 대부분 접수 이후에
판명됩니다 — 수신자가 카카오톡을 쓰지 않거나(`3104`) 알림톡을 차단한 경우(`3107`)는
접수가 성공하고 **이통사 리포트에서만** 드러납니다.

```typescript
const messageService = new ClawOpsMessageService({
  clawops, solapi, from: '07052358010',
  fallback: {
    enabled: true,
    mode: 'sweep',                 // 리포트를 주기적으로 훑는다
    intervalMs: 5 * 60_000,        // 기본 5분
    lookbackMs: 60 * 60_000,       // 커서가 없을 때 거슬러 볼 구간. 기본 1시간
    except: RECOMMENDED_EXCLUDED_CODES,  // 기본은 3XXX 전부. 덮으면 안 되는 것만 뺀다
    types: ['ATA'],                // 훑을 타입. 친구톡까지 보려면 ['ATA','CTA','CTI']
    onFallback: (e) => logger.info({ messageId: e.messageId, statusCode: e.statusCode }, '대체발송'),
    onBlocked:  (e) => logger.warn({ messageId: e.messageId, reason: e.reason }, '대체발송 못 함'),
    onError:    (e) => logger.error({ err: e }, '스윕 실패'),  // ← 지정하지 않으면 조용히 넘어갑니다
  },
});
```

⚠️ **`onError` 를 지정하지 않으면 스윕이 통째로 실패해도 아무 소리가 나지 않습니다.** 솔라피
조회가 막히거나 자격증명이 만료되면 다음 주기에 다시 시도할 뿐이고, 그동안 대체발송은
한 건도 나가지 않습니다. 실패가 계속되면 **문자가 안 나가는데 로그도 조용한** 상태가 되므로,
운영에 올리실 때는 반드시 지정하십시오.

`onError` 는 스윕 **전체**가 실패했을 때만 불립니다. 개별 건의 실패는 `onBlocked` 로 갑니다
(문구를 만들지 못했거나 ClawOps 가 거절한 경우) — 한 건이 실패해도 나머지는 그대로 진행됩니다.

커서를 프로세스 밖에 보관하시려면 `initialCursor` 로 넣고 `onCursor` 로 받으십시오. 재시작 후
같은 구간을 다시 훑는 것을 줄여 줍니다(멱등키가 있어 중복 발송은 어차피 막히지만, 요청은 아낍니다).

```typescript
fallback: {
  enabled: true,
  mode: 'sweep',
  initialCursor: await loadCursor(),   // 없으면 lookbackMs 만큼 거슬러 본다
  onCursor: (cursor) => saveCursor(cursor),  // 직렬화 가능한 값만 담겨 있습니다
}
```

**켜기만 하면 됩니다.** 커서·저장소·크론이 필요 없습니다. 발송할 때 `customFields` 에 마커를
심어 두고, 스윕이 그 마커가 있는 실패 건만 골라 문자를 보냅니다. 고객이 솔라피로 직접 보낸
알림톡은 마커가 없어 건드리지 않습니다.

같은 건을 두 번 보내지 않도록 두 장치가 다르게 동작합니다 — **커서와 처리 집합**이 재조회를
막고(정상 운영 중에는 요청이 아예 안 나갑니다), **멱등키**가 프로세스 재시작처럼 커서가 비는
순간의 안전망입니다.

알림톡 실패는 `3XXX` 로만 판정합니다 — 모르는 코드가 오면 실패로 단정하지 않고 다음 스윕에서 다시 봅니다.
ClawOps 가 대체 문자를 거절하면 `onBlocked` 에 `reason: 'send_rejected'` 로 알리고, 다음 스윕이
다시 시도합니다(멱등키가 같아 중복 발송은 되지 않습니다).

##### 어떤 코드를 대체발송할지

**기본은 3XXX 전부입니다.** 코드를 골라 담지 않았습니다 — 알림톡이라고 `31xx` 만 오는 게
아니기 때문입니다. 실측에서 알림톡 건에 `3058`(전송경로 없음)이 돌아왔습니다. 목록을 추리면
그렇게 새는 코드가 조용히 미발송이 됩니다.

대신 **문자로 덮으면 안 되는 코드가 섞여 있습니다.** `RECOMMENDED_EXCLUDED_CODES` 를
`except` 로 넘겨 빼시는 것을 권합니다.

| 군 | 코드 | 덮으면 생기는 일 |
|---|---|---|
| 수신거부 | `3061` | 080 수신거부한 분께 문자가 나갑니다 |
| 스팸·발신번호 변작 차단 | `3054` `3055` `3059` `3112` `3113` | 막힌 발송을 문자로 우회하는 셈이 됩니다 |
| 설정 오류 | `3013` `3101` `3103` `3105` `3106` `3109` `3117` | 전건이 실패하는데 문자가 덮어, 알림톡이 깨진 걸 오래 모르게 됩니다. 단가도 조용히 올라갑니다 |
| 시간 규제 | `3108` | 발송 가능 시간이 아닌데 문자로 나갑니다 |

```typescript
import { RECOMMENDED_EXCLUDED_CODES } from '@teamlearners/clawops/solapi';

fallback: {
  enabled: true,
  mode: 'sweep',
  except: RECOMMENDED_EXCLUDED_CODES,          // 권장 제외
  // except: [...RECOMMENDED_EXCLUDED_CODES, '3032'],  // 더 빼려면 이어 붙이십시오
}
```

`on` 은 반대로 **대상을 좁힙니다** — 주시면 그 코드만 나갑니다. `on` 으로 좁힌 뒤 `except` 로
다시 뺄 수도 있습니다. `on: []` 는 아무것도 보내지 않는다는 뜻이라 기본(전부)과 구별됩니다.

빠진 코드는 조용히 사라지지 않고 `onBlocked` 에 `reason: 'code_not_eligible'` 로 **알립니다.**

**상주 프로세스가 없다면**(서버리스·크론) 같은 일을 하는 함수를 직접 부르십시오.

```typescript
import { sweepFailedAlimtalk } from '@teamlearners/clawops/solapi';

const result = await sweepFailedAlimtalk({
  clawops, solapi, from: '07052358010',
  cursor: await loadCursor(),      // 없으면 lookback 만큼 거슬러 본다
});
await saveCursor(result.cursor);   // 직렬화 가능한 값만 담겨 있다
```

#### 문자 전용 모드

솔라피를 아예 쓰지 않는다면 `solapi` 를 넘기지 않아도 됩니다.
이때는 타입에서도 `send` 만 노출되어, 솔라피 전용 메서드를 부르면 **컴파일 단계에서** 막힙니다.

```typescript
const messageService = new ClawOpsMessageService({ clawops, from: '07052358010' });
await messageService.send({ to: '01012345678', text: '문자' });
```

#### 알아두어야 할 것

- **다음 경우에는 요청을 그대로 솔라피에 넘깁니다** — 대체발송 마커를 심지 않고 `from`·`disableSms`
  도 건드리지 않으므로, 솔라피 자체 대체발송이 그대로 동작합니다: `fallback` 을 껐을 때,
  브랜드메시지(`kakaoOptions.bms`), 그리고 `customFields` 가 이미 10개(솔라피 상한)를 다 썼을 때.
- **`mode: 'sweep'` 은 한 인스턴스에서만 켜십시오.** 여러 프로세스가 동시에 스윕하면 같은 건을
  함께 집어 문자가 두 번 나갈 수 있습니다 — 멱등키는 순차 재시도를 막을 뿐, 완전히 동시에 들어온
  두 요청은 통과합니다. 다중 인스턴스라면 크론에서 `sweepFailedAlimtalk()` 를 한 번만 부르십시오.
- 스윕은 알림톡 리포트가 확정된 뒤에 동작하므로 **대체발송에 지연이 있습니다**(스윕 주기 + 리포트
  확정 시간). 즉시 도달해야 하는 메시지는 처음부터 문자로 보내십시오.
- **예약 발송·중복 제거는 지원하지 않습니다.** ClawOps 로 가는 메시지가 있는데 `scheduledDate`
  또는 `allowDuplicates: false` 가 오면 조용히 무시하지 않고 에러를 던집니다.
- 문자 발송이 개별적으로 실패하면 나머지 건은 그대로 접수되고, 실패 건만
  `failedMessageList` 에 `statusCode: 'CLAWOPS'` 로 담깁니다. 솔라피 상태 코드가 아닙니다.
- 문자만 보낸 요청의 `groupInfo` 중 `balance`·`point`·`price`·`countForCharge` 는 ClawOps 에
  대응 개념이 없어 **0/빈 값**이고, `groupId` 는 `CLAWOPS-` 로 시작하는 자체 값이라
  `getGroupMessages()` 로 조회되지 않습니다.
- 알림톡이 포함된 요청은 솔라피가 준 `groupInfo` 를 이어받되, 접수 집계
  (`total`·`registeredSuccess`·`registeredFailed`)는 우리가 보낸 문자까지 합쳐 다시 셉니다.
  발송 단계 집계(`sentSuccess` 등)는 솔라피 값 그대로입니다.
- 전화번호는 하이픈 유무와 무관하게 처리합니다(`010-1111-2222` 로 보내도 됩니다).
- 광고성 알림톡을 문자로 대체발송하면 광고 문자에 요구되는 표기·수신거부 안내·야간 발송 제한이
  적용됩니다. 해당 템플릿은 `disableSms: true` 로 두거나 `customFields` 로 문구를 조정하십시오.

### 멀티 계정 접근

```typescript
// 다른 계정의 리소스에 접근
const other = client.accounts('AC_other_account_id');
await other.calls.list();
await other.numbers.list();
await other.messages.list();
```

## 웹훅 서명 검증

```typescript
client.webhooks.verify({
  url: 'https://my-app.com/webhook',
  params: { CallId: 'CA...', CallStatus: 'completed' },
  signature: request.headers['x-signature'],
  signingKey: 'your_account_signing_key',
});
```

서명이 유효하지 않으면 `WebhookVerificationError`가 발생합니다.

## 에러 처리

```typescript
import ClawOps, { BadRequestError, AuthenticationError, NotFoundError } from '@teamlearners/clawops';

const client = new ClawOps();

try {
  const call = await client.calls.create({ to: '01012345678', from: '07052358010', url: 'https://...' });
} catch (e) {
  if (e instanceof BadRequestError) {
    console.log(`잘못된 요청: ${e.status} - ${JSON.stringify(e.body)}`);
  } else if (e instanceof AuthenticationError) {
    console.log(`유효하지 않은 API 키: ${e.status}`);
  } else if (e instanceof NotFoundError) {
    console.log(`리소스를 찾을 수 없음: ${e.status}`);
  }
}
```

모든 에러는 `ClawOpsError`를 상속합니다. HTTP 에러는 `status`, `code`, `body` 속성을 제공합니다.

**사유는 `code` 로 분기하세요** — 한 상태 코드가 서로 다른 사유를 담고, 한글 메시지는 바뀔 수
있습니다. 서버가 `code` 를 싣지 않은 응답에서는 `undefined` 입니다.

```typescript
import { UnprocessableEntityError } from '@teamlearners/clawops';

try {
  await client.messages.create({ to, from, kakao: { channelId, templateId, variables } });
} catch (e) {
  if (e instanceof UnprocessableEntityError && e.code === 'recipient_blocked') {
    // 수신거부 — 재시도하면 안 됩니다
  } else if (e instanceof BadRequestError && e.code === 'kakao_variable_missing') {
    // 템플릿 변수 누락 — templates.list() 의 variables 를 다시 확인하세요
  }
}
```

| 에러                       | 상태 코드 |
| -------------------------- | --------- |
| `BadRequestError`          | 400       |
| `AuthenticationError`      | 401       |
| `PermissionDeniedError`    | 403       |
| `NotFoundError`            | 404       |
| `ConflictError`            | 409       |
| `UnprocessableEntityError` | 422       |
| `InternalServerError`      | 500+      |
| `ServiceUnavailableError`  | 503       |

## 설정

### 재시도

기본적으로 `408`, `409`, `429`, `500+` 에러 시 지수 백오프로 최대 2회 재시도합니다.

```typescript
const client = new ClawOps({ maxRetries: 5 });

// 재시도 비활성화
const client = new ClawOps({ maxRetries: 0 });
```

### 타임아웃

기본 타임아웃은 600초입니다. 클라이언트 단위로 변경할 수 있습니다:

```typescript
const client = new ClawOps({ timeout: 30_000 }); // 30초 (밀리초)
```

### 커스텀 fetch

프록시 등 고급 설정이 필요한 경우 커스텀 `fetch` 함수를 주입할 수 있습니다:

```typescript
import { ProxyAgent } from 'undici';

const dispatcher = new ProxyAgent('http://proxy.example.com:8080');
const client = new ClawOps({
  fetch: (url, init) => fetch(url, { ...init, dispatcher }),
});
```

## 환경변수

| 변수                 | 설명                   | 필수 여부                                   |
| -------------------- | ---------------------- | ------------------------------------------- |
| `CLAWOPS_API_KEY`    | API 키 (`sk_...`)      | 예 (생성자에 전달하지 않은 경우)            |
| `CLAWOPS_ACCOUNT_ID` | 기본 계정 ID (`AC...`) | 예 (생성자에 전달하지 않은 경우)            |
| `CLAWOPS_BASE_URL`   | API 기본 URL           | 아니오 (기본값: `https://api.claw-ops.com`) |
| `OPENAI_API_KEY`     | OpenAI API 키          | OpenAI Realtime 사용 시                     |
| `GOOGLE_API_KEY`     | Google API 키          | Gemini Realtime 사용 시                     |

## 문서

- **[AI Agent 가이드](docs/agent/)** — 음성 에이전트 상세 사용법, 파이프라인 모드, 커스텀 제공자, MCP 연동

## 다른 언어

| 언어 | 패키지 | 저장소 |
|------|--------|--------|
| Python | [`clawops`](https://pypi.org/project/clawops/) | [sdk-python](https://github.com/clawopshq/sdk-python) |

## 요구사항

- Node.js 18+
- `zod` >= 3.23
- `ws` >= 8.0 (Agent 사용 시)

## 라이선스

Apache-2.0
