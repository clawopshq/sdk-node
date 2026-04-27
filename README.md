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

// AI Completion 모드 — AI가 직접 통화를 처리
const aiCall = await client.calls.create({
  to: '01012345678',
  from: '07052358010',
  ai: {
    provider: 'openai',
    model: 'gpt-realtime',
    apiKey: process.env.OPENAI_API_KEY!,
    voice: 'marin',
    messages: [{ role: 'system', content: '당신은 예약 확인 AI입니다.' }],
  },
});

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

### 전화번호 (Numbers)

```typescript
// 번호 구매
const number = await client.numbers.create({ source: 'pool' });
console.log(number.phoneNumber);

// 번호 목록 조회
const numbers = await client.numbers.list();

// 웹훅 URL 변경
await client.numbers.update('07012340001', { webhookUrl: 'https://my-app.com/webhook' });

// 번호 해제
await client.numbers.delete('07012340001');
```

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
    console.log(`잘못된 요청: ${e.statusCode} - ${JSON.stringify(e.body)}`);
  } else if (e instanceof AuthenticationError) {
    console.log(`유효하지 않은 API 키: ${e.statusCode}`);
  } else if (e instanceof NotFoundError) {
    console.log(`리소스를 찾을 수 없음: ${e.statusCode}`);
  }
}
```

모든 에러는 `ClawOpsError`를 상속합니다. HTTP 에러는 `statusCode`, `body` 속성을 제공합니다.

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
| Python | [`clawops`](https://pypi.org/project/clawops/) | [clawops-python](https://github.com/learners-superpumped/clawops-python) |

## 요구사항

- Node.js 18+
- `zod` >= 3.23
- `ws` >= 8.0 (Agent 사용 시)

## 라이선스

Apache-2.0
