/**
 * PipelineSession orchestrates STT -> LLM -> TTS for a voice call.
 */

import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from '../audio.js';
import { BuiltinTool } from '../builtin-tool.js';
import type { AudioRecorder } from '../recorder.js';
import type { CallSession } from '../session.js';
import { ToolRegistry } from '../tool.js';
import type {
  ConversationMessage,
  LLM,
  LLMChunk,
  Session,
  STT,
  TTS,
} from './base.js';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';

const COLLECT_DTMF_TOOL = {
  type: 'function' as const,
  function: {
    name: 'collect_dtmf',
    description: '사용자로부터 DTMF(전화 키패드) 입력을 수집합니다.',
    parameters: {
      type: 'object' as const,
      properties: {
        max_digits: { type: 'integer' as const, description: '수집할 최대 자릿수' },
        finish_on_key: { type: 'string' as const, description: '입력 종료 키 (기본: #)' },
        timeout: { type: 'integer' as const, description: '입력 대기 시간(초, 기본: 5)' },
      },
      required: ['max_digits'] as string[],
    },
  },
};

const SEND_DTMF_TOOL = {
  type: 'function' as const,
  function: {
    name: 'send_dtmf',
    description: 'DTMF 신호를 전송합니다. ARS 메뉴 탐색이나 내선번호 입력 시 사용합니다.',
    parameters: {
      type: 'object' as const,
      properties: {
        digits: { type: 'string' as const, description: "전송할 번호 (0-9, *, #). 'w'는 500ms 대기, 'W'는 1000ms 대기." },
      },
      required: ['digits'] as string[],
    },
  },
};

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
  private _builtinTools: Set<BuiltinTool> | null = null;
  private _log: Logger = NOOP_LOGGER;

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

  setBuiltinTools(tools: Set<BuiltinTool>): void {
    this._builtinTools = tools;
  }

  setLogger(logger: Logger): void {
    this._log = logger;
    if ('setLogger' in this._stt && typeof (this._stt as any).setLogger === 'function') {
      (this._stt as any).setLogger(logger);
    }
    if ('setLogger' in this._tts && typeof (this._tts as any).setLogger === 'function') {
      (this._tts as any).setLogger(logger);
    }
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._callSession = callSession;
    this._tools = tools ?? null;
    this._running = true;
    this._log.info('PipelineSession started');
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
        this._log.error({ err }, 'Greeting error');
      });
    }

    // Start the STT listening loop
    this._runSttLoop().catch((err) => {
      this._log.error({ err }, 'STT loop error');
    });
  }

  feedAudio(audio: Buffer): void {
    if (this._running) {
      this._audioBuffer.push(audio);
    }
  }

  async feedDtmf(digits: string): Promise<void> {
    this._conversation.push({
      role: 'user',
      content: `[DTMF 입력: ${digits}]`,
    });
    await this._respond();
  }

  async stop(): Promise<void> {
    this._running = false;
    this._log.info('PipelineSession stopped');
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
        this._log.info('Barge-in: "%s"', event.transcript.substring(0, 30));
      }

      if (event.type === 'final' && event.transcript.trim()) {
        this._log.info('STT: %s', event.transcript);
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

  private _buildEffectiveTools(): ToolRegistry | undefined {
    const includeCollectDtmf = !this._builtinTools || this._builtinTools.has(BuiltinTool.COLLECT_DTMF);
    const includeSendDtmf = !this._builtinTools || this._builtinTools.has(BuiltinTool.SEND_DTMF);

    if (!includeCollectDtmf && !includeSendDtmf) return this._tools ?? undefined;

    // Inject DTMF tool stubs into a forked registry so the LLM sees them
    const base = this._tools ? this._tools.fork() : new ToolRegistry();
    if (includeCollectDtmf) {
      base.register({
        name: 'collect_dtmf',
        description: COLLECT_DTMF_TOOL.function.description,
        parameters: COLLECT_DTMF_TOOL.function.parameters.properties as Record<string, unknown>,
        required: COLLECT_DTMF_TOOL.function.parameters.required,
        handler: async () => '',
      });
    }
    if (includeSendDtmf) {
      base.register({
        name: 'send_dtmf',
        description: SEND_DTMF_TOOL.function.description,
        parameters: SEND_DTMF_TOOL.function.parameters.properties as Record<string, unknown>,
        required: SEND_DTMF_TOOL.function.parameters.required,
        handler: async () => '',
      });
    }
    return base;
  }

  private async _respond(): Promise<void> {
    // Run LLM generation (may include tool calls)
    let fullResponse = '';
    const textChunks: string[] = [];

    const effectiveTools = this._buildEffectiveTools();
    const llmStream = this._llm.generate(this._conversation, {
      tools: effectiveTools,
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
      this._log.info('Assistant: %s', fullResponse.substring(0, 100));
      this._conversation.push({ role: 'assistant', content: fullResponse });
      // Synthesize and send audio
      await this._synthesizeAndSend(fullResponse);
    }
  }

  private async _handleToolCall(chunk: LLMChunk): Promise<void> {
    if (!chunk.toolCall) return;

    const { id, name, arguments: argsStr } = chunk.toolCall;

    try {
      const args = JSON.parse(argsStr) as Record<string, unknown>;

      // Built-in DTMF tools - intercept before registry lookup
      if (name === 'collect_dtmf' && this._callSession) {
        let result: string;
        try {
          result = await this._callSession.collectDtmf({
            maxDigits: (args['max_digits'] as number) ?? 4,
            finishOnKey: (args['finish_on_key'] as string) ?? '#',
            timeout: (args['timeout'] as number) ?? 5,
          });
        } catch (err) {
          result = `Error: ${err}`;
        }
        this._conversation.push({ role: 'tool', content: result || '(타임아웃 - 입력 없음)', tool_call_id: id, name });
        await this._respond();
        return;
      }

      if (name === 'send_dtmf' && this._callSession) {
        let result: string;
        try {
          await this._callSession.sendDtmfSequence((args['digits'] as string) ?? '');
          result = 'sent';
        } catch (err) {
          result = `Error: ${err}`;
        }
        this._conversation.push({ role: 'tool', content: result, tool_call_id: id, name });
        await this._respond();
        return;
      }

      if (!this._tools) return;
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
      const effectiveTools = this._buildEffectiveTools();
      let followUpText = '';
      const followUpStream = this._llm.generate(this._conversation, {
        tools: effectiveTools,
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
      this._log.error({ err }, 'Tool call failed: %s', name);
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
      this._log.error({ err }, 'TTS error');
    } finally {
      this._speaking = false;
    }
  }
}
