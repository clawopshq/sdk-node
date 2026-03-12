# 제공자 호환성

ClawOps Voice Agent SDK의 제공자 목록입니다. 검증 상태를 확인하고 사용하세요.

> 커스텀 제공자를 직접 구현할 수도 있습니다. [커스텀 제공자 가이드](custom-providers.md)를 참고하세요.

## Realtime (Speech-to-Speech)

단일 API로 음성 입력부터 음성 출력까지 처리하는 end-to-end 방식입니다.

| 제공자 | 클래스 | 기본 모델 | Tool Calling | 환경변수 | Python | Node | 상태 | 검증일 |
|--------|--------|-----------|:------------:|----------|:------:|:----:|:----:|--------|
| OpenAI Realtime API | `OpenAIRealtime` | `gpt-realtime-1.5` | ✅ | `OPENAI_API_KEY` | ✅ | ✅ | **검증 완료** | 2026-03-12 |
| Google Gemini Live API | `GeminiRealtime` | `gemini-2.5-flash-native-audio-preview-12-2025` | — | `GOOGLE_API_KEY` | — | — | 검증 전 | — |

> **⚠️ Gemini Live API Known Issue:** function calling과 실시간 오디오 스트리밍을 함께 사용할 때 WebSocket 1008 (Policy Violation) 에러로 세션이 간헐적으로 종료될 수 있습니다. Google 서버 측 알려진 이슈입니다.
> - [Google AI Forum #114644](https://discuss.ai.google.dev/t/gemini-live-api-websocket-error-1008-operation-is-not-implemented-or-supported-or-enabled/114644)
> - [googleapis/js-genai #1236](https://github.com/googleapis/js-genai/issues/1236)

## Pipeline 모드 제공자

STT → LLM → TTS를 개별 조합하는 방식입니다. `PipelineSession`에서 사용합니다.

### STT (Speech-to-Text)

| 제공자 | 클래스 | 프로토콜 | VAD | Barge-in | 환경변수 | Python | Node | 상태 | 검증일 |
|--------|--------|----------|:---:|:--------:|----------|:------:|:----:|:----:|--------|
| Deepgram | `DeepgramSTT` | WebSocket 스트리밍 | — | — | `DEEPGRAM_API_KEY` | — | — | 검증 전 | — |

### LLM (Large Language Model)

| 제공자 | 클래스 | API 방식 | Tool Calling | Streaming | 환경변수 | Python | Node | 상태 | 검증일 |
|--------|--------|----------|:------------:|:---------:|----------|:------:|:----:|:----:|--------|
| OpenAI | `OpenAILLM` | Native SDK | — | — | `OPENAI_API_KEY` | — | — | 검증 전 | — |
| Anthropic | `AnthropicLLM` | Native SDK | — | — | `ANTHROPIC_API_KEY` | — | — | 검증 전 | — |
| Google Gemini | `GeminiLLM` | Native SDK | — | — | `GOOGLE_API_KEY` | — | — | 검증 전 | — |
| Ollama | `OllamaLLM` | OpenAI 호환 | — | — | `OLLAMA_BASE_URL` | — | — | 검증 전 | — |
| Mistral | `MistralLLM` | OpenAI 호환 | — | — | `MISTRAL_API_KEY` | — | — | 검증 전 | — |
| Groq | `GroqLLM` | OpenAI 호환 | — | — | `GROQ_API_KEY` | — | — | 검증 전 | — |
| Perplexity | `PerplexityLLM` | OpenAI 호환 | — | — | `PERPLEXITY_API_KEY` | — | — | 검증 전 | — |
| Together AI | `TogetherLLM` | OpenAI 호환 | — | — | `TOGETHER_API_KEY` | — | — | 검증 전 | — |
| Fireworks AI | `FireworksLLM` | OpenAI 호환 | — | — | `FIREWORKS_API_KEY` | — | — | 검증 전 | — |
| DeepSeek | `DeepSeekLLM` | OpenAI 호환 | — | — | `DEEPSEEK_API_KEY` | — | — | 검증 전 | — |
| xAI (Grok) | `XaiLLM` | OpenAI 호환 | — | — | `XAI_API_KEY` | — | — | 검증 전 | — |

**OpenAI 호환 API를 사용하는 다른 제공자**가 있다면 `OpenAICompatLLM`으로 직접 연결할 수 있습니다.

### TTS (Text-to-Speech)

| 제공자 | 클래스 | 프로토콜 | Sample Rate | 환경변수 | Python | Node | 상태 | 검증일 |
|--------|--------|----------|-------------|----------|:------:|:----:|:----:|--------|
| ElevenLabs | `ElevenLabsTTS` | WebSocket 스트리밍 | 24kHz (기본) | `ELEVENLABS_API_KEY` | — | — | 검증 전 | — |

## 설치

```bash
# 코어 패키지 (모든 제공자 포함)
npm install @teamlearners/clawops

# 환경변수 설정 (사용하는 제공자만)
OPENAI_API_KEY=sk-...               # OpenAI Realtime / LLM (검증 완료)
GOOGLE_API_KEY=AI...                 # Gemini Realtime / LLM
ANTHROPIC_API_KEY=sk-ant-...         # Anthropic LLM
DEEPGRAM_API_KEY=...                 # Deepgram STT
ELEVENLABS_API_KEY=...               # ElevenLabs TTS
MISTRAL_API_KEY=...                  # Mistral LLM
GROQ_API_KEY=gsk_...                 # Groq LLM
PERPLEXITY_API_KEY=pplx-...          # Perplexity LLM
TOGETHER_API_KEY=...                 # Together AI LLM
FIREWORKS_API_KEY=...                # Fireworks AI LLM
DEEPSEEK_API_KEY=sk-...              # DeepSeek LLM
XAI_API_KEY=xai-...                  # xAI LLM
```

## 세션 타입별 비교

| | OpenAI Realtime | Gemini Realtime | Pipeline |
|---|:---:|:---:|:---:|
| **방식** | Speech-to-Speech | Speech-to-Speech | STT → LLM → TTS |
| **지연** | 낮음 | 낮음 | 중간 |
| **Barge-in** | 내장 VAD | 내장 VAD | Deepgram VAD |
| **LLM 선택** | OpenAI 전용 | Gemini 전용 | 11개 제공자 자유 선택 |
| **음성 선택** | OpenAI 음성 | Google 음성 | ElevenLabs 등 자유 선택 |
| **Tool Calling** | ✅ | — | — |
| **비용** | Realtime API 요금 | Gemini API 요금 | 각 제공자 개별 요금 |
| **상태** | **검증 완료** | 검증 전 | 검증 전 |

## 범례

| 기호 | 의미 |
|:----:|------|
| ✅ | 기능 지원 |
| ⚠️ | 알려진 이슈 있음, 조건부 동작 |
| — | 미검증 |
| **검증 완료** | 실제 통화 환경에서 테스트 완료 |
| 검증 전 | 구현은 완료되었으나 실제 통화 환경 테스트 미완료 |

---

*마지막 업데이트: 2026-03-12*
