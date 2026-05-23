/**
 * Google Gemini Realtime API session (speech-to-speech).
 *
 * Uses @google/genai SDK's live.connect() method.
 * Matches Python SDK's GeminiRealtime implementation (v0.14.0).
 */

import type { CallSession } from '../../session.js';
import type { ToolRegistry } from '../../tool.js';
import type { AudioRecorder } from '../../recorder.js';
import type { Session } from '../base.js';
import type { SessionTelemetry } from '../../telemetry.js';
import type { LiveServerMessage, LiveServerToolCall } from '@google/genai/node';
import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from '../../audio.js';
import { BuiltinTool } from '../../builtin-tool.js';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../../logger.js';
import { HoldAudioPlayer } from '../../hold-audio.js';
import {
  BUILTIN_TOOL_NAMES,
  executeBuiltinTool,
  getBuiltinToolSchemas,
} from '../builtin-tool-schemas.js';

/**
 * $ref 문자열을 $defs에서 찾아 반환한다.
 */
function resolveRef(ref: string, defs: Record<string, unknown>): Record<string, unknown> {
  const parts = ref.replace(/^#\//, '').split('/');
  let result: unknown = defs;
  for (const part of parts) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      result = (result as Record<string, unknown>)[part];
    } else {
      return {};
    }
  }
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}

/**
 * JSON Schema를 Gemini functionDeclarations 호환 형식으로 변환한다.
 *
 * - $ref를 인라인으로 resolve
 * - oneOf/anyOf/allOf를 단순화 (첫 번째 object 타입 또는 첫 번째 항목 사용)
 * - 지원되지 않는 키워드 제거
 * - 재귀 깊이 제한으로 순환 참조 방지
 */
function sanitizeSchemaForGemini(
  schema: Record<string, unknown>,
  defs?: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 15) return { type: 'object', properties: {} };
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };

  // 최상위에서 $defs 추출
  if (defs === undefined) {
    defs = (schema['$defs'] ?? schema['definitions'] ?? {}) as Record<string, unknown>;
  }

  // $ref resolve
  if (typeof schema['$ref'] === 'string') {
    const resolved = resolveRef(schema['$ref'], { $defs: defs, definitions: defs });
    if (resolved && Object.keys(resolved).length > 0) {
      return sanitizeSchemaForGemini(resolved, defs, depth + 1);
    }
    return { type: 'object', properties: {} };
  }

  // oneOf / anyOf / allOf 처리
  for (const comboKey of ['oneOf', 'anyOf', 'allOf'] as const) {
    const variants = schema[comboKey];
    if (Array.isArray(variants) && variants.length > 0) {
      // object 타입 우선 선택
      for (const v of variants) {
        if (v && typeof v === 'object') {
          const resolved = sanitizeSchemaForGemini(v as Record<string, unknown>, defs, depth + 1);
          if (resolved['type'] === 'object' && resolved['properties']) {
            return resolved;
          }
        }
      }
      // 없으면 첫 번째 항목
      const first = variants[0];
      if (first && typeof first === 'object') {
        return sanitizeSchemaForGemini(first as Record<string, unknown>, defs, depth + 1);
      }
    }
  }

  const result: Record<string, unknown> = {};

  // type 처리 - 배열 type에서 null 제거
  let schemaType = schema['type'];
  if (Array.isArray(schemaType)) {
    const nonNull = schemaType.filter((t) => t !== 'null');
    schemaType = nonNull[0] ?? 'string';
  }
  if (schemaType) result['type'] = schemaType;

  // description 유지
  if (schema['description']) result['description'] = schema['description'];

  // enum 유지
  if (schema['enum']) result['enum'] = schema['enum'];

  // required 유지
  if (schema['required']) result['required'] = schema['required'];

  // properties 재귀 처리
  if (schema['properties'] && typeof schema['properties'] === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema['properties'] as Record<string, unknown>)) {
      if (val && typeof val === 'object') {
        props[key] = sanitizeSchemaForGemini(val as Record<string, unknown>, defs, depth + 1);
      }
    }
    result['properties'] = props;
  }

  // items 재귀 처리 (array)
  if (schema['items'] && typeof schema['items'] === 'object' && !Array.isArray(schema['items'])) {
    result['items'] = sanitizeSchemaForGemini(
      schema['items'] as Record<string, unknown>,
      defs,
      depth + 1,
    );
  }

  // type이 없고 properties가 있으면 object로 추정
  if (!result['type'] && result['properties']) result['type'] = 'object';

  // type이 object인데 properties가 없으면 빈 properties 추가
  if (result['type'] === 'object' && !result['properties']) result['properties'] = {};

  return result;
}

export interface GeminiRealtimeOptions {
  /** Google API key. Falls back to GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** System prompt / instructions for the AI. */
  systemPrompt?: string;
  /** Model to use. Default: 'gemini-3.1-flash-live-preview' */
  model?: string;
  /** Voice name. Default: 'Kore' */
  voice?: string;
  /** Language code. Default: 'ko' */
  language?: string;
  /** Send initial greeting. Default: true */
  greeting?: boolean;
  /** Gemini VAD config. @google/genai RealtimeInputConfig 구조 그대로 전달. */
  realtimeInputConfig?: Record<string, unknown>;
}

export class GeminiRealtime implements Session {
  private _apiKey: string;
  private _systemPrompt: string;
  private _model: string;
  private _voice: string;
  private _language: string;
  private _greeting: boolean;
  private _realtimeInputConfig: Record<string, unknown> | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _session: any = null;
  private _call: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _recorder: AudioRecorder | null = null;
  private _closed = false;
  private _sentAudioChunks = 0;
  private _audioRemainder: Buffer = Buffer.alloc(0);
  private _builtinTools: Set<BuiltinTool> | null = null;
  private _pendingToolCall: LiveServerToolCall | null = null;
  private _toolDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastAudioTime = 0;
  private _holdAudioChunks: Buffer[] | null = null;
  private _log: Logger = NOOP_LOGGER;

  constructor(options: GeminiRealtimeOptions = {}) {
    this._apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'] ?? '';
    this._systemPrompt = options.systemPrompt ?? '';
    this._model = options.model ?? 'gemini-3.1-flash-live-preview';
    this._voice = options.voice ?? 'Kore';
    this._language = options.language ?? 'ko';
    this._greeting = options.greeting ?? true;
    this._realtimeInputConfig = options.realtimeInputConfig ?? null;
  }

  /** Inject per-call ToolRegistry. */
  setToolRegistry(registry: ToolRegistry): void {
    this._tools = registry;
  }

  /** Inject per-call AudioRecorder. */
  setRecorder(recorder: AudioRecorder): void {
    this._recorder = recorder;
  }

  setBuiltinTools(tools: Set<BuiltinTool>): void {
    this._builtinTools = tools;
  }

  /** Tool 실행 중 재생할 hold audio 청크를 설정한다. */
  setHoldAudio(chunks: Buffer[]): void {
    this._holdAudioChunks = chunks;
  }

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  getTelemetry(): SessionTelemetry {
    return {
      sessionType: 'gemini_realtime',
      llm: { provider: 'gemini', model: this._model },
      stt: null,
      tts: null,
      voice: this._voice,
      language: this._language,
      greetingEnabled: this._greeting,
      recordingEnabled: !!this._recorder,
      toolCount: this._tools?.size ?? 0,
      mcpServerCount: 0,
      builtinTools: [],
    };
  }

  /** Open Live session (no CallSession). Audio deltas accumulate into BufferingCall until attach(). */
  async prewarm(): Promise<void> {
    const { BufferingCall } = await import('../buffering-call.js');
    this._call = new BufferingCall() as unknown as CallSession;
    this._closed = false;
    this._sentAudioChunks = 0;
    this._audioRemainder = Buffer.alloc(0);

    // @google/genai의 conditional exports 타입이 bundler 모드에서
    // live 프로퍼티를 인식하지 못하므로 node 엔트리 직접 import
    const { GoogleGenAI } = await import('@google/genai/node');
    const client = this._apiKey ? new GoogleGenAI({ apiKey: this._apiKey }) : new GoogleGenAI({});

    const config: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this._voice,
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    if (this._realtimeInputConfig) {
      config['realtimeInputConfig'] = this._realtimeInputConfig;
    }

    if (this._systemPrompt) {
      config['systemInstruction'] = {
        parts: [{ text: this._systemPrompt }],
      };
    }

    const toolSchemas = this._buildToolSchemas();
    if (toolSchemas.length > 0) {
      config['tools'] = [{ functionDeclarations: toolSchemas }];
    }

    this._log.debug({ config }, 'Gemini SDK final config');

    this._session = await client.live.connect({
      model: this._model,
      config,
      callbacks: {
        onmessage: (msg) => this._handleMessage(msg),
        onerror: (err) => {
          this._log.error({ err }, 'Gemini SDK error');
        },
        onclose: (ev) => {
          this._log.info(
            { code: (ev as { code?: number })?.code ?? 'unknown' },
            'Gemini connection closed',
          );
          this._closed = true;
        },
      },
    });
    this._log.info('Gemini Live connected (prewarm)');

    if (this._greeting) {
      this._session.sendRealtimeInput({ text: '인사해 주세요.' });
    }
  }

  /** Attach a real CallSession to the prewarmed session and flush buffered audio. */
  async attach(callSession: CallSession): Promise<void> {
    const { BufferingCall } = await import('../buffering-call.js');
    const prev = this._call;
    this._call = callSession;
    if (prev instanceof BufferingCall) {
      for (const chunk of prev.drainBuffer()) {
        callSession.sendAudio(chunk);
      }
    }
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    if (tools) this._tools = tools;
    await this.prewarm();
    await this.attach(callSession);
  }

  feedAudio(audio: Buffer): void {
    if (this._session && !this._closed) {
      // G.711 ulaw 8kHz → PCM16 8kHz → PCM16 16kHz
      const pcm8k = ulawToPcm16(audio);
      const pcm16k = resamplePcm16(pcm8k, 8000, 16000);

      // SDK Blob.data expects base64 string, not Buffer
      this._session.sendRealtimeInput({
        audio: {
          data: Buffer.from(pcm16k).toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    }
  }

  async feedDtmf(digits: string): Promise<void> {
    if (this._session) {
      this._session.sendRealtimeInput({ text: `[DTMF 입력: ${digits}]` });
    }
  }

  async stop(): Promise<void> {
    this._closed = true;
    if (this._toolDrainTimer) {
      clearTimeout(this._toolDrainTimer);
      this._toolDrainTimer = null;
    }
    this._pendingToolCall = null;
    if (this._session) {
      try {
        this._session.close();
      } catch {
        // Ignore close errors
      }
      this._session = null;
    }
  }

  private _buildToolSchemas(): Array<Record<string, unknown>> {
    const toolDefs: Array<Record<string, unknown>> = this._tools
      ? this._tools.toOpenAITools().map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: sanitizeSchemaForGemini(
            (t.function.parameters ?? { type: 'object', properties: {} }) as Record<
              string,
              unknown
            >,
          ),
        }))
      : [];
    toolDefs.push(...getBuiltinToolSchemas(this._builtinTools, 'gemini'));
    return toolDefs;
  }

  private _handleMessage(msg: LiveServerMessage): void {
    if (!this._call) return;

    // Handle server content
    const serverContent = msg.serverContent;
    if (serverContent) {
      // Audio from model turn
      const modelTurn = serverContent.modelTurn;
      if (modelTurn) {
        for (const part of modelTurn.parts ?? []) {
          const inlineData = part.inlineData;
          if (inlineData?.data) {
            const mimeType = inlineData.mimeType ?? '';
            if (mimeType.includes('audio')) {
              this._handleAudioData(inlineData.data as string);
              if (this._pendingToolCall) this._lastAudioTime = Date.now();
            }
          }
          // NOTE: modelTurn text는 outputTranscription과 중복이므로 emit하지 않음
        }
      }

      // Turn complete - flush audio remainder
      if (serverContent.turnComplete) {
        this._log.debug('Turn complete');
        this._flushAudioRemainder();
      }

      // Barge-in (interrupt)
      if (serverContent.interrupted) {
        this._log.info('Barge-in detected');
        if (this._call) {
          this._call.clearAudio();
        }
        this._sentAudioChunks = 0;
        this._audioRemainder = Buffer.alloc(0);
      }

      // Input transcription (under serverContent in SDK)
      const inputText = serverContent.inputTranscription?.text;
      if (inputText && this._call) {
        this._log.info('User: %s', inputText);
        this._call._emit('transcript', 'user', inputText);
      }

      // Output transcription (under serverContent in SDK)
      const outputText = serverContent.outputTranscription?.text;
      if (outputText && this._call) {
        this._log.info('Assistant: %s', outputText);
        this._call._emit('transcript', 'assistant', outputText);
      }
    }

    // Handle tool calls — debounce로 남은 오디오 drain 후 실행
    if (msg.toolCall) {
      this._pendingToolCall = msg.toolCall;
      this._scheduleToolExecution();
    }

    // Handle tool call cancellation
    const toolCancellation = (msg as unknown as Record<string, unknown>)['toolCallCancellation'] as
      | { ids?: string[] }
      | undefined;
    if (toolCancellation) {
      this._log.info({ ids: toolCancellation.ids }, 'Tool call cancelled');
      this._pendingToolCall = null;
      if (this._toolDrainTimer) {
        clearTimeout(this._toolDrainTimer);
        this._toolDrainTimer = null;
      }
    }
  }

  private _handleAudioData(b64Data: string): void {
    if (!this._call) return;

    const pcm24k = Buffer.from(b64Data, 'base64');

    // PCM16 24kHz → PCM16 8kHz → G.711 ulaw
    const pcm8k = resamplePcm16(pcm24k, 24000, 8000);
    const ulaw = pcm16ToUlaw(pcm8k);

    // 160B frame alignment (160B = 20ms at 8kHz ulaw)
    // 프레임 정렬 후 한 번에 전송 (개별 160B 전송 대신 배치 전송)
    const combined = Buffer.concat([this._audioRemainder, ulaw]);
    const chunkSize = 160;
    const fullEnd = Math.floor(combined.length / chunkSize) * chunkSize;
    if (fullEnd > 0) {
      this._call.sendAudio(combined.subarray(0, fullEnd));
      this._sentAudioChunks += fullEnd / chunkSize;
    }
    this._audioRemainder = combined.subarray(fullEnd);
  }

  private _flushAudioRemainder(): void {
    if (this._audioRemainder.length > 0 && this._call) {
      const padded = Buffer.concat([
        this._audioRemainder,
        Buffer.alloc(160 - this._audioRemainder.length, 0xff),
      ]);
      this._call.sendAudio(padded);
      this._sentAudioChunks++;
      this._audioRemainder = Buffer.alloc(0);
    }
  }

  // Gemini는 tool_call 후에도 오디오를 계속 보내므로, 이 시간 내 응답이 없으면 drain 완료로 간주
  private static readonly TOOL_DRAIN_TIMEOUT = 300;

  private _scheduleToolExecution(): void {
    if (this._toolDrainTimer) return;
    this._lastAudioTime = Date.now();
    this._toolDrainTimer = setTimeout(() => {
      this._toolDrainTimer = null;
      if (Date.now() - this._lastAudioTime < GeminiRealtime.TOOL_DRAIN_TIMEOUT) {
        // 아직 오디오가 오고 있음 — 재스케줄
        this._scheduleToolExecution();
        return;
      }
      if (this._pendingToolCall) {
        const tc = this._pendingToolCall;
        this._pendingToolCall = null;
        this._handleToolCall(tc);
      }
    }, GeminiRealtime.TOOL_DRAIN_TIMEOUT);
  }

  private async _handleToolCall(toolCall: LiveServerToolCall): Promise<void> {
    const functionCalls = toolCall.functionCalls;
    if (!functionCalls) return;

    const responses: Array<Record<string, unknown>> = [];

    const player =
      this._holdAudioChunks && this._call
        ? new HoldAudioPlayer(this._call, this._holdAudioChunks)
        : null;
    player?.start();

    try {
      for (const fc of functionCalls) {
        const name = fc.name ?? '';
        const fcId = fc.id ?? '';
        const args = fc.args ?? {};
        this._log.info({ tool: name, args }, 'Tool call: %s', name);

        // Built-in tools
        if (BUILTIN_TOOL_NAMES.has(name) && this._call) {
          const result = await executeBuiltinTool(
            name,
            args as Record<string, unknown>,
            this._call,
          );
          if (result !== null) {
            if (name === 'hang_up') {
              this._log.info('hang_up: ending call');
              return;
            }
            this._log.info('Builtin tool result: %s -> %s', name, result);
            responses.push({ id: fcId, name, response: { result } });
            continue;
          }
        }

        if (!this._tools || !this._tools.has(name)) {
          this._log.error('Unknown tool: %s', name);
          responses.push({ id: fcId, name, response: { error: `Unknown tool: ${name}` } });
          continue;
        }

        try {
          this._call?.recordToolCall();
          const result = await this._tools.call(name, args);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          this._log.info('Tool result: %s -> %s', name, resultStr.substring(0, 200));
          responses.push({
            id: fcId,
            name,
            response: { result: resultStr },
          });
        } catch (err) {
          this._log.error({ err }, 'Tool call failed: %s', name);
          if (err instanceof Error) {
            this._call?.recordToolError(err);
          }
          responses.push({
            id: fcId,
            name,
            response: { error: String(err) },
          });
        }
      }
    } finally {
      player?.stop();
    }

    if (responses.length > 0 && this._session) {
      this._log.debug('Sending %d tool response(s)', responses.length);
      this._session.sendToolResponse({
        functionResponses: responses,
      });
    }
  }
}
