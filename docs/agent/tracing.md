# Tracing (OpenTelemetry)

통화 흐름, 도구 호출, LLM 세션을 OpenTelemetry span으로 추적할 수 있습니다. `@opentelemetry/api`가 설치되지 않은 환경에서는 자동으로 no-op 처리됩니다.

## 설치

```bash
npm install @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-grpc
```

## 사용법

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
provider.register();

import { ClawOpsAgent, OpenAIRealtime, setTracingConfig } from 'claw-ops/agent';

setTracingConfig({
  enabled: true,
  serviceName: 'my-call-center',
});

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '상담원입니다.',
  }),
});
```

## TracingConfig

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | Tracing 활성화 여부 |
| `serviceName` | `string` | `"clawops-agent"` | OTEL 서비스 이름 |

## Span 구조

```
call (call.id, call.from, call.to, call.duration_ms)
├── mcp.connect (mcp.server.type, mcp.tools.count)
├── llm.session (gen_ai.system, gen_ai.request.model)
│   └── llm.generation
├── tool.call (tool.name, tool.source, tool.duration_ms)
│   └── mcp.call_tool (mcp.tool.name, mcp.tool.is_error)
└── tool.call (tool.name, tool.source)
```

## Span Attribute

| Span | Attribute | 설명 |
|------|-----------|------|
| `call` | `call.id`, `call.from`, `call.to`, `call.duration_ms` | 통화 정보 |
| `mcp.connect` | `mcp.server.type`, `mcp.server.command`, `mcp.server.url`, `mcp.tools.count` | MCP 서버 |
| `llm.session` | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.request.voice` | LLM 세션 |
| `tool.call` | `tool.name`, `tool.source`, `tool.duration_ms` | 도구 호출 |
| `mcp.call_tool` | `mcp.tool.name`, `mcp.tool.is_error` | MCP 도구 |
