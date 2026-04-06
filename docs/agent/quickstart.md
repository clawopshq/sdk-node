# 빠른 시작

## 설치

```bash
# 기본 (OpenAI Realtime 모드)
npm install @teamlearners/clawops ws openai

# Gemini Realtime 모드
npm install @teamlearners/clawops ws @google/genai

# 파이프라인 모드
npm install @teamlearners/clawops ws @deepgram/sdk openai elevenlabs       # OpenAI LLM
npm install @teamlearners/clawops ws @deepgram/sdk @anthropic-ai/sdk elevenlabs  # Anthropic LLM
npm install @teamlearners/clawops ws @deepgram/sdk @google/genai elevenlabs # Gemini LLM

# MCP 서버 지원 포함
npm install @teamlearners/clawops ws @modelcontextprotocol/sdk
```

## 환경변수

```bash
export CLAWOPS_API_KEY="sk_..."
export CLAWOPS_ACCOUNT_ID="AC..."
export OPENAI_API_KEY="sk-..."           # OpenAI Realtime / OpenAILLM
export ANTHROPIC_API_KEY="..."           # AnthropicLLM
export GOOGLE_API_KEY="..."              # Gemini Realtime / GeminiLLM
export MISTRAL_API_KEY="..."             # MistralLLM
export GROQ_API_KEY="..."               # GroqLLM
export PERPLEXITY_API_KEY="..."          # PerplexityLLM
export TOGETHER_API_KEY="..."            # TogetherLLM
export FIREWORKS_API_KEY="..."           # FireworksLLM
export DEEPSEEK_API_KEY="..."            # DeepSeekLLM
export XAI_API_KEY="..."                 # XaiLLM
export DEEPGRAM_API_KEY="..."            # Pipeline: DeepgramSTT
export ELEVENLABS_API_KEY="..."          # Pipeline: ElevenLabsTTS
```

## 최소 예제

```typescript
import { ClawOpsAgent, OpenAIRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '친절한 고객센터 상담원입니다.',
  }),
});

await agent.serve(); // Ctrl+C로 종료
```

이것만으로 `07012341234` 번호로 걸려오는 전화를 AI가 처리합니다.

## 설정 옵션

```typescript
import { ClawOpsAgent, OpenAIRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  // 필수
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '상담원입니다.',
    voice: 'marin', // marin, ash, ballad, coral, sage, verse
    model: 'gpt-realtime-1.5',
    language: 'ko',
    turnDetection: { type: 'semantic_vad', eagerness: 'medium' },
    greeting: true,
  }),

  // 인증 (환경변수 대체 가능)
  apiKey: 'sk_...',
  accountId: 'AC...',

  // 녹음
  recording: true,
  recordingPath: './recordings',
});
```

### Gemini Realtime 사용 시

```typescript
import { ClawOpsAgent, GeminiRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new GeminiRealtime({
    systemPrompt: '상담원입니다.',
    voice: 'Kore',
    language: 'ko',
  }),
});
```

> **Note:** 기본 모델이 `gemini-3.1-flash-live-preview`로 업데이트되었습니다. 이전 `gemini-2.5-flash-native-audio-preview-12-2025` 모델은 더 이상 지원되지 않습니다.

### 음성 옵션

| 음성     | 특징                         |
| -------- | ---------------------------- |
| `marin`  | 기본값, 자연스러운 여성 음성 |
| `ash`    | 자연스러운 남성 음성         |
| `ballad` | 부드러운 남성 음성           |
| `coral`  | 밝은 여성 음성               |
| `sage`   | 차분한 여성 음성             |
| `verse`  | 중성적 음성                  |

## 발신 (Outbound Call)

```typescript
import { ClawOpsAgent, OpenAIRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012345678',
  session: new OpenAIRealtime({
    systemPrompt: '예약 확인 도우미입니다.',
  }),
});

// 발신만 하는 경우 — 자동으로 connect() 수행
const session = await agent.call('01012345678', { timeout: 30 });
console.log(session.callId); // 즉시 사용 가능
console.log(session.direction); // "outbound"
await session.wait(); // 통화 종료까지 대기
await agent.disconnect();

// 수신도 같이 하는 경우 (혼합 모드)
await agent.connect();
const session2 = await agent.call('01012345678');
// agent는 인바운드 수신도 계속 처리
```

| 파라미터  | 타입     | 기본값 | 설명                  |
| --------- | -------- | ------ | --------------------- |
| `to`      | `string` | 필수   | 수신 전화번호         |
| `timeout` | `number` | `60`   | 무응답 대기 시간 (초) |

## 에러 처리

```typescript
import { ClawOpsAgent, OpenAIRealtime } from '@teamlearners/clawops/agent';
import { AgentError, AgentConnectionError } from '@teamlearners/clawops';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '상담원입니다.',
  }),
});

try {
  await agent.serve();
} catch (e) {
  if (e instanceof AgentConnectionError) {
    console.log(`서버 연결 실패: ${e.message}`);
  } else if (e instanceof AgentError) {
    console.log(`에이전트 에러: ${e.message}`);
  }
}
```

| 에러                   | 설명                            |
| ---------------------- | ------------------------------- |
| `AgentError`           | Agent 관련 에러의 베이스 클래스 |
| `AgentConnectionError` | WebSocket 연결 실패             |
