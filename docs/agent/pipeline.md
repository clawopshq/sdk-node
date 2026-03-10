# 파이프라인 모드

Realtime API 대신 STT, LLM, TTS 제공자를 직접 조합하는 모드입니다. `PipelineSession`을 사용합니다.

## 기본 사용법

```typescript
import { ClawOpsAgent, PipelineSession, DeepgramSTT, OpenAILLM, ElevenLabsTTS } from '@teamlearners/clawops/agent';

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

## 오디오 처리 흐름

```
전화 오디오 (G.711 μ-law 8kHz)
    │
    ▼
PCM16 8kHz → PCM16 16kHz ──► STT ──► SpeechEvent
                                          │
                    ┌─────────────────────┘
                    ▼
               LLM (텍스트 스트림)
                    │
                    ▼
               TTS (PCM16 오디오)
                    │
                    ▼
         PCM16 → 8kHz → G.711 μ-law → 전화
```

## 내장 제공자

### DeepgramSTT

Deepgram Nova 모델을 사용한 실시간 음성 인식.

```typescript
import { DeepgramSTT } from '@teamlearners/clawops/agent';

const stt = new DeepgramSTT({
  model: 'nova-3',          // Deepgram 모델
  language: 'ko',           // 언어 코드
  endpointing: 300,         // 발화 종료 감지 (ms)
  utteranceEndMs: 1000,     // 발화 종료 대기 (ms)
});
```

환경변수: `DEEPGRAM_API_KEY`

**특징:**
- WebSocket 스트리밍 방식
- `SpeechStarted` VAD 이벤트로 빠른 barge-in 감지
- Interim/Final 결과 분리

### OpenAILLM

OpenAI Chat Completions 스트리밍.

```typescript
import { OpenAILLM } from '@teamlearners/clawops/agent';

const llm = new OpenAILLM({
  model: 'gpt-4o-mini',     // 모델명
  temperature: 0.8,
  maxTokens: 4096,
});
```

환경변수: `OPENAI_API_KEY`

**특징:**
- 스트리밍 텍스트 생성
- Tool call 자동 처리 (Chat Completions 포맷)

### AnthropicLLM

Anthropic Claude Messages 스트리밍.

```typescript
import { AnthropicLLM } from '@teamlearners/clawops/agent';

const llm = new AnthropicLLM({
  model: 'claude-sonnet-4-6',  // 모델명
  temperature: 0.8,
  maxTokens: 4096,
});
```

환경변수: `ANTHROPIC_API_KEY`

**특징:**
- 스트리밍 텍스트 생성
- Tool call 자동 처리 (OpenAI 메시지 포맷을 Anthropic 포맷으로 자동 변환)

### GeminiLLM

Google Gemini 스트리밍.

```typescript
import { GeminiLLM } from '@teamlearners/clawops/agent';

const llm = new GeminiLLM({
  model: 'gemini-2.5-flash',  // 모델명
  temperature: 0.8,
  maxTokens: 4096,
});
```

환경변수: `GOOGLE_API_KEY`

**특징:**
- 스트리밍 텍스트 생성
- Tool call 자동 처리 (OpenAI 메시지 포맷을 Gemini 포맷으로 자동 변환)

### OllamaLLM

Ollama 로컬 모델 스트리밍 (OpenAI 호환 API).

```typescript
import { OllamaLLM } from '@teamlearners/clawops/agent';

const llm = new OllamaLLM({
  model: 'llama3.2',           // Ollama 모델명
  baseUrl: 'http://localhost:11434/v1',  // 기본값
  temperature: 0.8,
  maxTokens: 4096,
});
```

환경변수: `OLLAMA_BASE_URL` (기본 `http://localhost:11434/v1`)

**특징:**
- OpenAI 호환 API 사용 (별도 SDK 불필요, `openai` 패키지 사용)
- 스트리밍 텍스트 생성
- Tool call 지원 (모델이 지원하는 경우)

### MistralLLM

Mistral AI 스트리밍 (OpenAI 호환 API).

```typescript
import { MistralLLM } from '@teamlearners/clawops/agent';

const llm = new MistralLLM({ model: 'mistral-small-latest' });
```

환경변수: `MISTRAL_API_KEY`

### GroqLLM

Groq 초저지연 스트리밍 (OpenAI 호환 API).

```typescript
import { GroqLLM } from '@teamlearners/clawops/agent';

const llm = new GroqLLM({ model: 'meta-llama/llama-4-scout-17b-16e-instruct' });
```

환경변수: `GROQ_API_KEY`

### PerplexityLLM

Perplexity 웹 검색 기반 스트리밍 (OpenAI 호환 API).

```typescript
import { PerplexityLLM } from '@teamlearners/clawops/agent';

const llm = new PerplexityLLM({ model: 'sonar' });
```

환경변수: `PERPLEXITY_API_KEY`

### TogetherLLM

Together AI 스트리밍 (OpenAI 호환 API).

```typescript
import { TogetherLLM } from '@teamlearners/clawops/agent';

const llm = new TogetherLLM({ model: 'meta-llama/Llama-4-Scout-17B-16E-Instruct' });
```

환경변수: `TOGETHER_API_KEY`

### FireworksLLM

Fireworks AI 스트리밍 (OpenAI 호환 API).

```typescript
import { FireworksLLM } from '@teamlearners/clawops/agent';

const llm = new FireworksLLM({ model: 'accounts/fireworks/models/llama4-scout-instruct-basic' });
```

환경변수: `FIREWORKS_API_KEY`

### DeepSeekLLM

DeepSeek 스트리밍 (OpenAI 호환 API).

```typescript
import { DeepSeekLLM } from '@teamlearners/clawops/agent';

const llm = new DeepSeekLLM({ model: 'deepseek-chat' });
```

환경변수: `DEEPSEEK_API_KEY`

### XaiLLM

xAI Grok 스트리밍 (OpenAI 호환 API).

```typescript
import { XaiLLM } from '@teamlearners/clawops/agent';

const llm = new XaiLLM({ model: 'grok-4-1-fast' });
```

환경변수: `XAI_API_KEY`

### ElevenLabsTTS

ElevenLabs WebSocket 스트리밍 음성 합성.

```typescript
import { ElevenLabsTTS } from '@teamlearners/clawops/agent';

const tts = new ElevenLabsTTS({
  voiceId: 'EXAVITQu4vr4xnSDxMaL',  // 음성 ID
  model: 'eleven_flash_v2_5',          // 모델
  outputFormat: 'pcm_24000',           // 출력 포맷
  languageCode: 'ko',
  stability: 0.5,
  similarityBoost: 0.75,
});
```

환경변수: `ELEVENLABS_API_KEY`

**특징:**
- WebSocket 스트리밍 (낮은 지연)
- `sampleRate` 속성 자동 추출 (`pcm_24000` → 24000)

## Barge-in (끼어들기)

사용자가 말하면 AI 오디오를 즉시 중단합니다.

1. **SpeechStarted** — Deepgram VAD가 음성 감지 → 오디오 버퍼 클리어
2. **Interim transcript** — 부분 인식 결과 (이미 VAD로 처리된 경우 무시)
3. **Final transcript** — 확정 텍스트 → 새 응답 생성

## Debounce

AI가 아직 말하기 전에 사용자가 추가 발화하면, 0.5초 대기 후 한 번에 응답합니다. 빠르게 연속 발화해도 불필요한 응답 생성을 방지합니다.

## 세션 타입 비교

| | OpenAI Realtime | Gemini Realtime | Pipeline |
|---|-----------------|-----------------|----------|
| 제공자 | OpenAI | Google | 자유 조합 |
| 지연 | 낮음 (단일 API) | 낮음 (단일 API) | 중간 (STT+LLM+TTS) |
| Barge-in | 내장 VAD | 내장 VAD | Deepgram VAD + clearAudio |
| 비용 | Realtime API 요금 | Gemini API 요금 | 각 제공자 개별 요금 |
| 음성 | OpenAI 음성 | Google 음성 | ElevenLabs 등 자유 선택 |

## 커스텀 제공자

내장 제공자 대신 직접 구현할 수 있습니다. 자세한 가이드는 [커스텀 제공자](custom-providers.md)를 참고하세요.
