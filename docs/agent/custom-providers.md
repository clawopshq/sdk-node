# 커스텀 제공자 구현 가이드

STT, LLM, TTS 제공자를 직접 구현하여 파이프라인 모드에서 사용할 수 있습니다. 각 제공자는 TypeScript 인터페이스를 구현하면 됩니다.

## 인터페이스 정의

```typescript
import type { STT, LLM, TTS, SpeechEvent, ConversationMessage, LLMChunk } from '@teamlearners/clawops/agent';
import type { ToolRegistry } from '@teamlearners/clawops/agent';
```

### SpeechEvent

STT가 반환하는 이벤트 타입입니다.

```typescript
interface SpeechEvent {
  type: 'interim' | 'final';
  transcript: string;
}
```

| 타입 | 용도 | transcript |
|------|------|-----------|
| `interim` | Barge-in 트리거 (AI 오디오 중단) | 빈 문자열 또는 부분 텍스트 |
| `final` | 확정 텍스트로 응답 생성 | 완성된 발화 텍스트 |

---

## STT 구현

```typescript
interface STT {
  transcribe(audioStream: AsyncIterable<Buffer>): AsyncGenerator<SpeechEvent>;
}
```

### 입력

- `audioStream`: PCM16 signed 16-bit LE, **16kHz**, mono
- 파이프라인이 전화 오디오(G.711 μ-law 8kHz)를 자동으로 변환하여 전달합니다

### 출력

- `SpeechEvent` 비동기 제너레이터
- `interim` 이벤트: 사용자가 말하기 시작했음을 알림 (barge-in용)
- `final` 이벤트: 발화가 완료된 확정 텍스트

### 예시: Whisper 기반 STT

```typescript
import type { SpeechEvent } from '@teamlearners/clawops/agent';

class WhisperSTT {
  private model: string;

  constructor(model = 'whisper-1') {
    this.model = model;
  }

  async *transcribe(audioStream: AsyncIterable<Buffer>): AsyncGenerator<SpeechEvent> {
    const buffer: Buffer[] = [];
    let totalLength = 0;
    const CHUNK_SIZE = 16000 * 2 * 2; // 2초 분량 (16kHz, 16bit)

    for await (const chunk of audioStream) {
      buffer.push(chunk);
      totalLength += chunk.length;

      if (totalLength >= CHUNK_SIZE) {
        const pcm = Buffer.concat(buffer);
        buffer.length = 0;
        totalLength = 0;

        const text = await this.recognize(pcm);
        if (text) {
          yield { type: 'interim', transcript: text };
          yield { type: 'final', transcript: text };
        }
      }
    }

    // 남은 버퍼 처리
    if (totalLength > 0) {
      const pcm = Buffer.concat(buffer);
      const text = await this.recognize(pcm);
      if (text) {
        yield { type: 'final', transcript: text };
      }
    }
  }

  private async recognize(pcm16: Buffer): Promise<string> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI();
    const wav = this.pcm16ToWav(pcm16);
    const file = new File([wav], 'audio.wav', { type: 'audio/wav' });
    const result = await client.audio.transcriptions.create({
      model: this.model,
      file,
    });
    return result.text;
  }

  private pcm16ToWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 30);
    header.writeUInt16LE(16, 32);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }
}
```

### Barge-in을 위한 권장사항

빠른 barge-in을 위해 다음을 권장합니다:

1. **VAD 이벤트 활용** — STT 서비스가 음성 시작 이벤트(예: Deepgram `SpeechStarted`)를 제공하면 즉시 `interim` 이벤트를 발생시키세요
2. **Interim 결과 활용** — 부분 인식 결과가 나오면 `interim` 이벤트로 보내세요
3. **로컬 VAD** — STT 서비스에 VAD가 없다면 Silero VAD 등을 앞단에 추가하세요

---

## LLM 구현

```typescript
interface LLM {
  generate(
    messages: ConversationMessage[],
    options?: { tools?: ToolRegistry; temperature?: number; maxTokens?: number },
  ): AsyncGenerator<LLMChunk>;
}
```

### 입력

- `messages`: OpenAI Chat Completions 포맷의 메시지 배열
  ```typescript
  [
    { role: 'system', content: '시스템 프롬프트' },
    { role: 'user', content: '사용자 발화' },
    { role: 'assistant', content: 'AI 응답' },
    { role: 'assistant', content: null, tool_calls: [...] },
    { role: 'tool', tool_call_id: '...', content: '도구 결과' },
  ]
  ```
- `options.tools`: 도구 레지스트리 (선택)

### 출력

- `LLMChunk` 비동기 제너레이터
  - 텍스트: `{ type: 'text', text: '...' }`
  - Tool call: `{ type: 'tool_calls', toolCalls: [{ id: '...', function: { name: '...', arguments: '...' } }] }`

### 예시: 커스텀 LLM

```typescript
import type { ConversationMessage, LLMChunk } from '@teamlearners/clawops/agent';
import type { ToolRegistry } from '@teamlearners/clawops/agent';

class MyLLM {
  async *generate(
    messages: ConversationMessage[],
    options?: { tools?: ToolRegistry; temperature?: number; maxTokens?: number },
  ): AsyncGenerator<LLMChunk> {
    // 1. messages에서 system, user, assistant, tool 역할을 읽어
    //    사용하는 LLM API에 맞게 변환합니다.
    // 2. tools가 있으면 OpenAI Chat Completions 포맷을 해당 API 포맷으로 변환합니다.
    // 3. 텍스트 토큰을 스트리밍으로 yield합니다.
    yield { type: 'text', text: '안녕하세요!' };
  }
}
```

### Tool Call 처리 규칙

1. 텍스트와 tool call을 동시에 반환하지 마세요. 텍스트 스트리밍이 끝난 후 tool call을 yield합니다.
2. `toolCalls[].id`는 고유해야 합니다. 파이프라인이 이 ID로 결과를 매칭합니다.
3. Tool 실행 후 파이프라인이 결과를 messages에 추가하고 `generate()`를 다시 호출합니다.

---

## TTS 구현

```typescript
interface TTS {
  synthesize(textStream: AsyncIterable<string>): AsyncGenerator<Buffer>;
  readonly sampleRate?: number;
}
```

### 입력

- `textStream`: 문장 단위로 분할된 텍스트 스트림
- 파이프라인이 LLM 출력을 문장 부호(`.!?。！？`) 기준으로 분할하여 전달합니다

### 출력

- PCM16 signed 16-bit LE 오디오 청크
- **sample rate**: 자유 (파이프라인이 8kHz로 리샘플링)
- `sampleRate` getter를 제공하면 파이프라인이 자동으로 리샘플링합니다. 없으면 24000Hz로 가정합니다.

### 예시: Google Cloud TTS

```typescript
class GoogleTTS {
  private voice: string;

  constructor(voice = 'ko-KR-Neural2-A') {
    this.voice = voice;
  }

  get sampleRate(): number {
    return 24000;
  }

  async *synthesize(textStream: AsyncIterable<string>): AsyncGenerator<Buffer> {
    const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
    const client = new TextToSpeechClient();

    for await (const text of textStream) {
      if (!text.trim()) continue;

      const [response] = await client.synthesizeSpeech({
        input: { text },
        voice: { languageCode: 'ko-KR', name: this.voice },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: this.sampleRate },
      });

      // WAV 헤더(44바이트) 제거 → raw PCM16
      const audio = response.audioContent as Buffer;
      yield audio.subarray(44);
    }
  }
}
```

### `sampleRate` 속성

파이프라인은 TTS 출력을 전화 오디오(8kHz)로 변환해야 합니다. `sampleRate` getter로 출력 sample rate를 알려주세요.

```typescript
get sampleRate(): number {
  return 24000; // 24kHz PCM16을 출력하는 경우
}
```

이 속성이 없으면 24000Hz로 가정합니다.

---

## 제공자 조합 예시

```typescript
import { ClawOpsAgent, PipelineSession, DeepgramSTT, AnthropicLLM } from '@teamlearners/clawops/agent';

// Deepgram STT + Anthropic Claude LLM + Google TTS
const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new PipelineSession({
    systemPrompt: '친절한 상담원입니다.',
    stt: new DeepgramSTT(),
    llm: new AnthropicLLM({ model: 'claude-sonnet-4-6' }),
    tts: new GoogleTTS('ko-KR-Neural2-A'),
  }),
});
```

세 제공자 모두 커스텀으로 교체하거나, 내장 제공자와 혼합할 수 있습니다.

---

## 체크리스트

커스텀 제공자 구현 시 확인할 항목:

### STT
- [ ] `transcribe()`가 `AsyncGenerator<SpeechEvent>`를 반환하는가?
- [ ] `interim` 이벤트를 발생시키는가? (barge-in에 필요)
- [ ] `final` 이벤트의 transcript가 빈 문자열이 아닌가?
- [ ] 입력 오디오가 PCM16 16kHz임을 전제로 하는가?

### LLM
- [ ] `generate()`가 `AsyncGenerator<LLMChunk>`를 반환하는가?
- [ ] messages 포맷이 OpenAI Chat Completions 호환인가?
- [ ] Tool call 시 올바른 `LLMChunk` 포맷을 yield하는가?
- [ ] Tool call의 `id` 필드가 고유한가?

### TTS
- [ ] `synthesize()`가 `AsyncGenerator<Buffer>`를 반환하는가?
- [ ] 출력이 raw PCM16 (WAV 헤더 없음)인가?
- [ ] `sampleRate` getter를 제공하는가?
- [ ] 빈 텍스트를 무시하는가?
