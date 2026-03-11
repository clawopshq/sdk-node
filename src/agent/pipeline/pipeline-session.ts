/**
 * PipelineSession orchestrates STT -> LLM -> TTS for a voice call.
 */

import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from '../audio.js';
import type { AudioRecorder } from '../recorder.js';
import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';
import type {
  ConversationMessage,
  LLM,
  LLMChunk,
  Session,
  STT,
  TTS,
} from './base.js';

export interface PipelineSessionOptions {
  stt: STT;
  llm: LLM;
  tts: TTS;
  /** System prompt for the LLM. */
  systemPrompt?: string;
  /** Send initial greeting. Default: true */
  greeting?: boolean;
  /** Language code. Default: 'ko' */
  language?: string;
  /** Tool registry for function calling. */
  toolRegistry?: ToolRegistry;
  /** Audio recorder for the session. */
  recorder?: AudioRecorder;
  /** LLM temperature. */
  temperature?: number;
  /** Max tokens for LLM generation. */
  maxTokens?: number;
  /** Sample rate for audio. Default: 8000 */
  sampleRate?: number;
  /** Whether to interrupt TTS when user starts speaking. Default: true */
  interruptOnSpeech?: boolean;
}

export class PipelineSession implements Session {
  private _stt: STT;
  private _llm: LLM;
  private _tts: TTS;
  private _systemPrompt: string | undefined;
  private _greeting: boolean;
  private _language: string;
  private _temperature: number | undefined;
  private _maxTokens: number | undefined;
  private _sampleRate: number;
  private _interruptOnSpeech: boolean;

  private _callSession: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _recorder: AudioRecorder | null = null;
  private _conversation: ConversationMessage[] = [];
  private _audioBuffer: Buffer[] = [];
  private _running = false;
  private _speaking = false;

  constructor(options: PipelineSessionOptions) {
    this._stt = options.stt;
    this._llm = options.llm;
    this._tts = options.tts;
    this._systemPrompt = options.systemPrompt;
    this._greeting = options.greeting ?? true;
    this._language = options.language ?? 'ko';
    this._temperature = options.temperature;
    this._maxTokens = options.maxTokens;
    this._sampleRate = options.sampleRate ?? 8000;
    this._interruptOnSpeech = options.interruptOnSpeech ?? true;
    if (options.toolRegistry) this._tools = options.toolRegistry;
    if (options.recorder) this._recorder = options.recorder;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this._tools = registry;
  }

  setRecorder(recorder: AudioRecorder): void {
    this._recorder = recorder;
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._callSession = callSession;
    this._tools = tools ?? null;
    this._running = true;
    this._conversation = [];

    if (this._systemPrompt) {
      this._conversation.push({
        role: 'system',
        content: this._systemPrompt,
      });
    }

    // Generate initial greeting if enabled
    if (this._greeting) {
      this._generateGreeting().catch((err) => {
        console.error('[PipelineSession] Greeting error:', err);
      });
    }

    // Start the STT listening loop
    this._runSttLoop().catch((err) => {
      console.error('[PipelineSession] STT loop error:', err);
    });
  }

  feedAudio(audio: Buffer): void {
    if (this._running) {
      this._audioBuffer.push(audio);
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    this._audioBuffer = [];
  }

  private async _runSttLoop(): Promise<void> {
    const audioStream = this._createAudioStream();

    for await (const event of this._stt.transcribe(audioStream, {
      sampleRate: this._sampleRate,
    })) {
      if (!this._running) break;

      if (event.type === 'interim' && this._speaking && this._interruptOnSpeech) {
        // User started speaking while TTS is active - interrupt
        this._speaking = false;
        if (this._callSession) {
          this._callSession.clearAudio();
        }
      }

      if (event.type === 'final' && event.transcript.trim()) {
        await this._handleUserSpeech(event.transcript);
      }
    }
  }

  private async *_createAudioStream(): AsyncGenerator<Buffer> {
    while (this._running) {
      if (this._audioBuffer.length > 0) {
        const ulaw = this._audioBuffer.shift()!;
        // G.711 ulaw 8kHz → PCM16 8kHz → PCM16 16kHz
        const pcm8k = ulawToPcm16(ulaw);
        const pcm16k = resamplePcm16(pcm8k, 8000, 16000);
        yield pcm16k;
      } else {
        // Wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  private async _generateGreeting(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this._respond();
  }

  private async _handleUserSpeech(transcript: string): Promise<void> {
    this._conversation.push({ role: 'user', content: transcript });
    await this._respond();
  }

  private async _respond(): Promise<void> {
    // Run LLM generation (may include tool calls)
    let fullResponse = '';
    const textChunks: string[] = [];

    const llmStream = this._llm.generate(this._conversation, {
      tools: this._tools ?? undefined,
      temperature: this._temperature,
      maxTokens: this._maxTokens,
    });

    for await (const chunk of llmStream) {
      if (!this._running) break;

      if (chunk.type === 'text' && chunk.text) {
        textChunks.push(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        await this._handleToolCall(chunk);
      }
    }

    if (fullResponse.trim()) {
      this._conversation.push({ role: 'assistant', content: fullResponse });
      // Synthesize and send audio
      await this._synthesizeAndSend(fullResponse);
    }
  }

  private async _handleToolCall(chunk: LLMChunk): Promise<void> {
    if (!chunk.toolCall || !this._tools) return;

    const { id, name, arguments: argsStr } = chunk.toolCall;

    try {
      const args = JSON.parse(argsStr) as Record<string, unknown>;
      const result = await this._tools.call(name, args);

      this._conversation.push({
        role: 'assistant',
        content: '',
        // Tool call info stored in the message flow
      });
      this._conversation.push({
        role: 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result),
        tool_call_id: id,
        name,
      });

      // Re-generate after tool result
      let followUpText = '';
      const followUpStream = this._llm.generate(this._conversation, {
        tools: this._tools ?? undefined,
        temperature: this._temperature,
        maxTokens: this._maxTokens,
      });

      for await (const followChunk of followUpStream) {
        if (!this._running) break;
        if (followChunk.type === 'text' && followChunk.text) {
          followUpText += followChunk.text;
        }
      }

      if (followUpText.trim()) {
        this._conversation.push({ role: 'assistant', content: followUpText });
        await this._synthesizeAndSend(followUpText);
      }
    } catch (err) {
      console.error(`[PipelineSession] Tool call error for ${name}:`, err);
    }
  }

  private async _synthesizeAndSend(text: string): Promise<void> {
    if (!this._callSession || !this._running) return;

    this._speaking = true;

    try {
      for await (const audioChunk of this._tts.synthesize(text, {
        sampleRate: this._sampleRate,
      })) {
        if (!this._running || !this._speaking) break;
        if (this._recorder) {
          const pcm8k = this._sampleRate !== 8000
            ? resamplePcm16(audioChunk, this._sampleRate, 8000)
            : audioChunk
          this._recorder.writeOutbound(pcm8k)
        }
        // Resample TTS output → 8kHz → ulaw, send in 160B frames
        const pcm8k = resamplePcm16(audioChunk, this._sampleRate, 8000);
        const ulaw = pcm16ToUlaw(pcm8k);
        for (let off = 0; off < ulaw.length; off += 160) {
          let chunk = ulaw.subarray(off, off + 160);
          if (chunk.length < 160) {
            chunk = Buffer.concat([chunk, Buffer.alloc(160 - chunk.length, 0xff)]);
          }
          this._callSession.sendAudio(chunk);
        }
      }
    } catch (err) {
      console.error('[PipelineSession] TTS error:', err);
    } finally {
      this._speaking = false;
    }
  }
}
