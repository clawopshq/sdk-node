# ClawOps Agent

AI 음성 에이전트 프레임워크. 인바운드/아웃바운드 전화를 AI로 자동 처리합니다.

WebSocket 역방향 연결 방식으로 ngrok 없이 로컬에서 바로 실행할 수 있습니다.

## 문서 목록

| 문서 | 내용 |
|------|------|
| [빠른 시작](quickstart.md) | 설치, 환경변수, 기본 사용법 |
| [파이프라인 모드](pipeline.md) | 커스텀 STT/LLM/TTS 조합 |
| [커스텀 제공자](custom-providers.md) | 나만의 STT/LLM/TTS 제공자 구현 가이드 |
| [Tool](tools.md) | AI 함수 호출 (`agent.tool()`) |
| [이벤트 & CallSession](events.md) | 통화 이벤트 핸들러, CallSession API |
| [MCP 서버](mcp.md) | MCP 서버 연동 |
| [녹음](recording.md) | 통화 녹음 설정 |
| [Tracing](tracing.md) | OpenTelemetry 연동 |
| [아키텍처](architecture.md) | 내부 구조, 보안 모델 |

## 동작 원리

```
┌──────────────┐    Control WS     ┌──────────────┐
│  ClawOpsAgent │◄─────────────────►│ ClawOps 서버  │
│  (로컬 실행)  │    Media WS (콜별) │              │
│              │◄─────────────────►│              │
└──────┬───────┘                   └──────────────┘
       │
       ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ OpenAI       │  │ Gemini       │  │ Pipeline     │
│ Realtime API │  │ Live API     │  │ STT→LLM→TTS  │
└──────────────┘  └──────────────┘  └──────────────┘
```

1. **Agent가 서버에 연결** — Control WebSocket으로 역방향 연결
2. **전화 수신 알림** — 서버가 `call.incoming` 이벤트 전송
3. **미디어 스트림 연결** — 콜별 Media WebSocket으로 오디오 스트리밍
4. **AI 처리** — 선택한 세션 타입으로 음성 대화
5. **Tool 호출** — AI가 필요 시 등록된 함수 자동 호출

## 시작 방법

| 메서드 | 용도 |
|--------|------|
| `agent.serve()` | 인바운드 서버 모드 (SIGINT/SIGTERM까지 대기, 자동 disconnect) |
| `agent.connect()` | Control WS 연결만 (논블로킹, 아웃바운드/혼합 모드용) |
| `agent.disconnect()` | 연결 해제 |
| `agent.call(to)` | 발신 전화 (미연결 시 자동 connect) |
| `session.wait()` | 통화 종료까지 대기 |

## 세션 타입

`ClawOpsAgent`의 `session` 옵션으로 세션 타입을 지정합니다.

### OpenAI Realtime

OpenAI Realtime API를 사용한 Speech-to-Speech 방식.

```typescript
import { ClawOpsAgent, OpenAIRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '친절한 상담원입니다.',
  }),
});
```

### Gemini Realtime

Google Gemini Live API를 사용한 Speech-to-Speech 방식.

```typescript
import { ClawOpsAgent, GeminiRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new GeminiRealtime({
    systemPrompt: '친절한 상담원입니다.',
    voice: 'Kore',
  }),
});
```

### Pipeline 모드

STT, LLM, TTS 제공자를 직접 조합합니다. 제공자를 자유롭게 교체할 수 있습니다.

```typescript
import { ClawOpsAgent } from '@teamlearners/clawops/agent';
import { PipelineSession, DeepgramSTT, OpenAILLM, ElevenLabsTTS } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new PipelineSession({
    systemPrompt: '친절한 상담원입니다.',
    stt: new DeepgramSTT(),
    llm: new OpenAILLM({ model: 'gpt-4o-mini' }),
    tts: new ElevenLabsTTS(),
  }),
});
```

자세한 내용은 [파이프라인 모드](pipeline.md) 문서를 참고하세요.
