/**
 * Google Gemini Realtime API session (speech-to-speech).
 *
 * Uses @google/genai SDK's live.connect() method.
 * Matches Python SDK's GeminiRealtime implementation (v0.14.0).
 */

import type { CallSession } from '../../session.js';
import type { ToolRegistry, ToolBehavior, ToolScheduling } from '../../tool.js';
import { TOOL_SCHEDULINGS } from '../../tool.js';
import type { AudioRecorder } from '../../recorder.js';
import type { Session } from '../base.js';
import { BufferingCall, attachBuffered } from '../buffering-call.js';
import type { SessionTelemetry } from '../../telemetry.js';
import type { LiveServerMessage, LiveServerToolCall } from '@google/genai/node';
import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from '../../audio.js';
import { BuiltinTool } from '../../builtin-tool.js';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../../logger.js';
import { HoldAudioPlayer, holdAudioAllowed } from '../../hold-audio.js';
import {
  BUILTIN_TOOL_NAMES,
  CALL_NOT_READY_RESULT,
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

/** connect 부터 setupComplete 까지 기다리는 상한. 3.8 Live 는 핸드셰이크+setup 이 10초를 넘긴 적이 있다(2026-09-29 실측). */
const SETUP_TIMEOUT_MS = 15_000;

/** Gemini Live 함수 선언의 `behavior` 허용값(= `ToolBehavior`). */
export type GeminiToolBehavior = ToolBehavior;
export const GEMINI_TOOL_BEHAVIORS: readonly GeminiToolBehavior[] = ['BLOCKING', 'NON_BLOCKING'];

/** `CLAWOPS_GEMINI_DEBUG=1` 이면 Live 서버 메시지를 한 줄씩 info 로 남긴다(오디오는 바이트 수만). */
const TRACE_ENABLED = ['1', 'true', 'yes'].includes(
  (process.env['CLAWOPS_GEMINI_DEBUG'] ?? '').toLowerCase(),
);

export function isExtendedThinkingModel(model: string): boolean {
  return model.includes('extended-thinking');
}

/**
 * 모델별 함수 호출 `behavior` 기본값.
 *
 * - `gemini-3.8-live-extended-thinking` 은 NON_BLOCKING 만 받고 BLOCKING 은 하드 에러다.
 * - `gemini-3.8-live` 는 서버 기본값이 NON_BLOCKING 으로 바뀌었다(모델 페이지 「Migrating from
 *   Gemini 3.1 Flash Live」). behavior 를 안 보내면 서버는 도구를 비동기로 돌려, 도구 결과를
 *   기다리는 동안 모델이 계속 말한다. 전화 SDK 는 결과를 기다리는 동안 모델이 말하지 않아야
 *   하므로 BLOCKING 을 명시해 3.1 과 같은 동작을 복원한다.
 * - 그 외(3.1 등)는 보내지 않는다(서버 기본값 = 동기).
 *
 * LiveKit `livekit-plugins-google` 의 `_default_tool_behavior` 와 같은 자리이되, 기본값 방향은
 * 반대다(LiveKit 은 3.8 에 NON_BLOCKING 을 명시한다).
 */
export function defaultToolBehavior(model: string): GeminiToolBehavior | null {
  if (isExtendedThinkingModel(model)) return 'NON_BLOCKING';
  if (model.includes('3.8')) return 'BLOCKING';
  return null;
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
  /**
   * 입력 음성 전사 설정. @google/genai AudioTranscriptionConfig 구조 그대로 `inputAudioTranscription` 에 실린다.
   * `languageCodes`(BCP-47 목록)·`customVocabulary`(최대 1,000개)를 받는다. 지정하지 않으면 `{}`.
   */
  inputAudioTranscription?: Record<string, unknown>;
  /**
   * Gemini thinking 설정. @google/genai ThinkingConfig 구조 그대로 전달.
   * `gemini-3.8-live-extended-thinking` 은 `{ thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH' }` 이 필수다.
   */
  thinkingConfig?: Record<string, unknown>;
  /**
   * Gemini proactive audio. `proactivity.proactiveAudio` 에 그대로 실린다.
   * 3.8 두 모델은 영구 ON 이라 `false` 를 보내면 거절되고, 3.1 은 미지원이다. 지정하지 않으면 보내지 않는다.
   */
  proactiveAudio?: boolean;
  /**
   * 함수 선언의 `behavior`. 지정하지 않으면 모델별 기본값({@link defaultToolBehavior}):
   * `gemini-3.8-live` 는 BLOCKING, `gemini-3.8-live-extended-thinking` 은 NON_BLOCKING, 그 외는 보내지 않음.
   */
  toolBehavior?: GeminiToolBehavior;
  /**
   * NON_BLOCKING 도구 결과의 기본 `scheduling`(`SILENT`·`WHEN_IDLE`·`INTERRUPT`). 도구별 값이 이를 덮는다.
   * BLOCKING 결과에는 서버가 무시하고, extended-thinking 은 거절하므로 보내지 않는다.
   */
  toolResponseScheduling?: ToolScheduling;
  /** Gemini API 버전(`v1beta` 기본). `GoogleGenAI({ httpOptions: { apiVersion } })` 로 넘긴다. */
  apiVersion?: string;
  /**
   * Gemini `contextWindowCompression` 그대로 전달. 압축을 켜지 않은 오디오 세션은 15분에서 끝나므로
   * 긴 통화에는 `{ slidingWindow: {} }` 를 권장. 지정하지 않으면 보내지 않는다.
   */
  contextWindowCompression?: Record<string, unknown>;
  /**
   * 세션 재접속(기본 true). 접속 때마다 `sessionResumption` 핸들을 보내 서버가 주는 새 핸들을 보관하고,
   * `goAway`(연결 약 10분 한도)·예기치 않은 끊김에서 그 핸들로 다시 접속해 대화를 이어 간다.
   */
  sessionResumption?: boolean;
  /** 재접속 시도 상한(기본 3). 다 실패하면 통화에 `session_lost` 를 알리고 끊는다. */
  reconnectMaxAttempts?: number;
}

export class GeminiRealtime implements Session {
  /**
   * Gemini Live 는 connect 시점의 config 로 도구가 고정되어 세션 도중 변경할 수 없다.
   *
   * 통화 시작 시점에야 붙는 MCP 도구는 prewarm 된 세션에 넣을 방법이 없으므로,
   * `ClawOpsAgent` 가 MCP 서버 설정과 이 플래그를 보고 prewarm 을 건너뛴다.
   */
  readonly toolsFrozenAfterPrewarm = true;

  private _apiKey: string;
  private _systemPrompt: string;
  private _model: string;
  private _voice: string;
  private _language: string;
  private _greeting: boolean;
  private _realtimeInputConfig: Record<string, unknown> | null;
  private _inputAudioTranscription: Record<string, unknown> | null;
  private _thinkingConfig: Record<string, unknown> | null;
  private _proactiveAudio: boolean | null;
  private _toolBehavior: GeminiToolBehavior | null;
  private _toolResponseScheduling: ToolScheduling | null;
  private _apiVersion: string | null;
  private _traceT0 = Date.now();
  // 선언 시점에 확정한 도구별 behavior·scheduling. 응답을 보낼 때 같은 값을 읽는다(LiveKit 과 같은 원칙:
  // 선언과 scheduling 판정이 한 값을 읽어야 「서버는 비동기인데 우리는 동기」가 안 생긴다).
  private _declaredBehavior = new Map<string, GeminiToolBehavior | null>();
  private _declaredScheduling = new Map<string, ToolScheduling | null>();
  // 진행 중인 NON_BLOCKING 호출. Promise 는 끊을 수 없으니 취소 표시만 하고 끝나도 응답을 안 보낸다.
  private _inflight = new Map<string, { cancelled: boolean }>();
  private _schedulingDroppedWarned = false;
  // ── 세션 수명(LiveKit livekit-plugins-google 의 처리를 이식) ──
  private _contextWindowCompression: Record<string, unknown> | null;
  private _sessionResumption: boolean;
  private _reconnectMaxAttempts: number;
  private _resumptionHandle: string | null = null;
  private _reconnecting = false;
  private _stopping = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _client: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _session: any = null;
  private _call: CallSession | BufferingCall | null = null;
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
    this._inputAudioTranscription = options.inputAudioTranscription ?? null;
    this._thinkingConfig = options.thinkingConfig ?? null;
    this._proactiveAudio = options.proactiveAudio ?? null;
    if (
      options.toolBehavior !== undefined &&
      !GEMINI_TOOL_BEHAVIORS.includes(options.toolBehavior)
    ) {
      throw new Error(
        `toolBehavior must be one of ${GEMINI_TOOL_BEHAVIORS.join(', ')}, got ${String(options.toolBehavior)}`,
      );
    }
    this._toolBehavior = options.toolBehavior ?? null;
    if (
      options.toolResponseScheduling !== undefined &&
      !TOOL_SCHEDULINGS.includes(options.toolResponseScheduling)
    ) {
      throw new Error(
        `toolResponseScheduling must be one of ${TOOL_SCHEDULINGS.join(', ')}, got ${String(options.toolResponseScheduling)}`,
      );
    }
    this._toolResponseScheduling = options.toolResponseScheduling ?? null;
    this._apiVersion = options.apiVersion ?? null;
    this._contextWindowCompression = options.contextWindowCompression ?? null;
    this._sessionResumption = options.sessionResumption ?? true;
    this._reconnectMaxAttempts = Math.max(0, options.reconnectMaxAttempts ?? 3);
  }

  /**
   * 선언 하나에 실을 behavior 를 정한다.
   * - extended-thinking 은 NON_BLOCKING 만 받으므로 무엇을 요청해도 NON_BLOCKING(요청이 BLOCKING 이면 경고).
   * - 내장 도구(hang_up·collect_dtmf·send_dtmf·transfer_call)는 통화 제어라 항상 BLOCKING —
   *   NON_BLOCKING 이면 모델이 끊기·전환 중에도 말을 이어 가 음성이 잘린다.
   * - 그 외는 도구별 요청 → 세션 기본값 순.
   */
  private _behaviorFor(
    name: string,
    requested: GeminiToolBehavior | undefined,
    builtin: boolean,
  ): GeminiToolBehavior | null {
    if (isExtendedThinkingModel(this._model)) {
      if (requested === 'BLOCKING') {
        this._log.warn(
          'tool %s requested BLOCKING but %s accepts NON_BLOCKING only — declaring NON_BLOCKING',
          name,
          this._model,
        );
      }
      return 'NON_BLOCKING';
    }
    if (builtin) return this.effectiveToolBehavior() ? 'BLOCKING' : null;
    return requested ?? this.effectiveToolBehavior();
  }

  /**
   * 응답에 실을 `scheduling`. NON_BLOCKING 선언에만 의미가 있고 BLOCKING 엔 서버가 무시한다.
   * extended-thinking 은 scheduling 을 거절(1007 "Function response scheduling is not supported")하므로
   * 절대 보내지 않는다. 결과가 없고(=모델에 전할 말이 없음) 따로 정한 값이 없으면 SILENT.
   */
  private _schedulingFor(name: string, resultIsEmpty: boolean): ToolScheduling | undefined {
    if (this._declaredBehavior.get(name) !== 'NON_BLOCKING') return undefined;
    const requested =
      this._declaredScheduling.get(name) ?? this._toolResponseScheduling ?? undefined;
    if (isExtendedThinkingModel(this._model)) {
      if (requested && !this._schedulingDroppedWarned) {
        this._schedulingDroppedWarned = true;
        this._log.warn(
          '%s rejects FunctionResponse.scheduling; dropping scheduling=%s',
          this._model,
          requested,
        );
      }
      return undefined;
    }
    if (requested) return requested;
    return resultIsEmpty ? 'SILENT' : undefined;
  }

  /** 이 세션의 함수 선언에 실리는 `behavior`. 지정이 없으면 모델별 기본값. */
  effectiveToolBehavior(): GeminiToolBehavior | null {
    return this._toolBehavior ?? defaultToolBehavior(this._model);
  }

  /** `CLAWOPS_GEMINI_DEBUG=1` 일 때만 서버·클라이언트 이벤트를 한 줄로 남긴다. */
  private _trace(event: string, fields: Record<string, unknown> = {}): void {
    if (!TRACE_ENABLED) return;
    const kv = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== false)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
    this._log.info('[gemini-trace] +%dms %s %s', Date.now() - this._traceT0, event, kv);
  }

  private _traceMessage(msg: LiveServerMessage): void {
    const sc = msg.serverContent;
    if (sc) {
      let audioBytes = 0;
      for (const part of sc.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data;
        if (typeof data === 'string') audioBytes += Math.floor((data.length * 3) / 4);
      }
      const extra = sc as unknown as Record<string, unknown>;
      this._trace('server_content', {
        audio_bytes: audioBytes || undefined,
        turn_complete: sc.turnComplete,
        turn_complete_reason: extra['turnCompleteReason'],
        generation_complete: sc.generationComplete,
        waiting_for_input: extra['waitingForInput'],
        interrupted: sc.interrupted,
        input_transcript: sc.inputTranscription?.text,
        output_transcript: sc.outputTranscription?.text,
      });
    }
    if (msg.toolCall) {
      this._trace('tool_call', {
        calls: (msg.toolCall.functionCalls ?? [])
          .map((fc) => `${fc.name ?? ''}#${fc.id ?? ''}`)
          .join(','),
      });
    }
    const cancel = (msg as unknown as Record<string, unknown>)['toolCallCancellation'] as
      | { ids?: string[] }
      | undefined;
    if (cancel) this._trace('tool_call_cancellation', { ids: (cancel.ids ?? []).join(',') });
    if (msg.goAway) this._trace('go_away', { time_left: msg.goAway.timeLeft });
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
  async prewarm(tools?: ToolRegistry): Promise<void> {
    if (tools) this._tools = tools;
    this._call = new BufferingCall();
    this._closed = false;
    this._stopping = false;
    this._resumptionHandle = null;
    this._sentAudioChunks = 0;
    this._audioRemainder = Buffer.alloc(0);

    // @google/genai의 conditional exports 타입이 bundler 모드에서
    // live 프로퍼티를 인식하지 못하므로 node 엔트리 직접 import
    const { GoogleGenAI } = await import('@google/genai/node');
    const clientOptions: Record<string, unknown> = {};
    if (this._apiKey) clientOptions['apiKey'] = this._apiKey;
    // 기본값은 v1beta. proactivity 등 일부 기능은 다른 버전을 요구할 수 있어 그대로 넘긴다.
    if (this._apiVersion) clientOptions['httpOptions'] = { apiVersion: this._apiVersion };
    this._client = new GoogleGenAI(clientOptions);
    this._traceT0 = Date.now();

    this._session = await this._connect();
    this._log.info('Gemini Live connected (prewarm)');

    if (this._greeting) {
      this._session.sendRealtimeInput({ text: '인사해 주세요.' });
    }
  }

  /** Live 연결 하나를 연다(setupComplete 까지 기다림). prewarm 과 재접속이 함께 쓴다. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _connect(): Promise<any> {
    const client = this._client;
    const config: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this._voice,
          },
        },
      },
      // 전사는 끌 수 없다(대화 기록·이벤트가 쓴다). 값을 주면 해석하지 않고 그대로 넘긴다.
      inputAudioTranscription: { ...(this._inputAudioTranscription ?? {}) },
      outputAudioTranscription: {},
    };

    if (this._realtimeInputConfig) {
      config['realtimeInputConfig'] = this._realtimeInputConfig;
    }

    // 모델마다 받는 키가 다르다(2026-09-29 실측): gemini-3.8-live-extended-thinking 은
    // thinkingLevel(LOW·MEDIUM·HIGH)이 없으면 연결을 거절하고, gemini-3.8-live 는
    // thinkingLevel 을 거절하고 thinkingBudget 만 받는다. 그래서 값을 해석하지 않고 그대로 넘긴다.
    if (this._thinkingConfig) {
      config['thinkingConfig'] = this._thinkingConfig;
    }

    // 3.8 두 모델은 proactive audio 가 영구 ON 이라 false 를 보내면 거절되고, 3.1 은 미지원이다.
    // 값을 해석하지 않고 그대로 넘긴다 — 모델별 표는 docs/agent/quickstart.md.
    if (this._proactiveAudio !== null) {
      config['proactivity'] = { proactiveAudio: this._proactiveAudio };
    }

    if (this._systemPrompt) {
      config['systemInstruction'] = {
        parts: [{ text: this._systemPrompt }],
      };
    }

    // 압축을 켜지 않은 오디오 세션은 15분에서 끝난다(공식 문서). 값은 해석하지 않고 그대로 넘긴다.
    if (this._contextWindowCompression !== null) {
      config['contextWindowCompression'] = this._contextWindowCompression;
    }
    // 핸들이 없어도 보내야 서버가 sessionResumptionUpdate 로 새 핸들을 준다.
    if (this._sessionResumption) {
      config['sessionResumption'] = this._resumptionHandle
        ? { handle: this._resumptionHandle }
        : {};
    }

    const toolSchemas = this._buildToolSchemas();
    if (toolSchemas.length > 0) {
      config['tools'] = [{ functionDeclarations: toolSchemas }];
    }

    this._log.debug({ config }, 'Gemini SDK final config');
    this._trace('connect', {
      model: this._model,
      tool_behavior: this.effectiveToolBehavior(),
      resume: !!this._resumptionHandle,
    });

    // live.connect() 는 WebSocket 이 열려야만 끝나고, 서버의 setup 거절(1007 등)은 연결이 열린
    // 뒤에 온다. 그래서 connect() 만 기다리면 열리기 전 에러에는 영원히 걸리고, setup 거절은
    // 성공으로 지나가 통화가 무음이 된다. setupComplete 를 받아야 prewarm 을 끝낸다
    // (Python google-genai 는 connect 가 setup 응답까지 기다린다 — 동작을 맞춘다).
    let setupDone!: () => void;
    let setupFailed!: (err: Error) => void;
    const setup = new Promise<void>((resolve, reject) => {
      setupDone = resolve;
      setupFailed = reject;
    });
    // 실패가 경주에서 진 뒤에 와도 unhandled rejection 이 되지 않게 한다.
    setup.catch(() => {});
    const timer = setTimeout(
      () => setupFailed(new Error(`Gemini Live setup timed out after ${SETUP_TIMEOUT_MS}ms`)),
      SETUP_TIMEOUT_MS,
    );

    let isSetUp = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let thisSession: any = null;
    const connecting = client.live.connect({
      model: this._model,
      config,
      callbacks: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onmessage: (msg: any) => {
          if (msg.setupComplete) {
            isSetUp = true;
            setupDone();
          }
          // 재접속으로 교체된 옛 연결의 메시지는 오디오·전사만 흘리고 제어 메시지는 무시한다.
          const stale =
            thisSession !== null && this._session !== null && this._session !== thisSession;
          this._handleMessage(msg, stale);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onerror: (err: any) => {
          this._log.error({ err }, 'Gemini SDK error');
          setupFailed(new Error('Gemini Live connection error'));
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onclose: (ev: any) => {
          const { code, reason } = (ev ?? {}) as { code?: number; reason?: string };
          // 1007 등 서버 거절 사유는 reason 에만 담긴다(예: "Thinking level must be specified").
          const fields = { code: code ?? 'unknown', reason: reason || undefined };
          if (code === 1000) this._log.info(fields, 'Gemini connection closed');
          else this._log.warn(fields, 'Gemini connection closed');
          if (!isSetUp) {
            setupFailed(
              new Error(
                `Gemini Live closed before setup completed (code ${code ?? 'unknown'}${reason ? `: ${reason}` : ''})`,
              ),
            );
            return;
          }
          // 통화 중 끊김. 이 연결이 아직 현재 세션이면(= goAway 재접속으로 이미 바뀐 게 아니면) 다시 접속한다.
          if (!this._stopping && thisSession !== null && this._session === thisSession) {
            void this._reconnect(
              `closed (code ${code ?? 'unknown'}${reason ? `: ${reason}` : ''})`,
            );
          }
        },
      },
    });

    try {
      thisSession = await Promise.race([connecting, setup.then(() => connecting)]);
      await setup;
    } catch (err) {
      // 열리기 전에 실패했으면 나중에 열리는 세션을 닫아 upstream 연결을 남기지 않는다.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void connecting.then((sess: any) => sess.close()).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    this._closed = false;
    return thisSession;
  }

  /** 연결 하나를 조용히 닫는다. 서버가 세션을 놓아야 같은 핸들로 다시 붙을 수 있다. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _closeQuietly(sess: any): Promise<void> {
    if (!sess) return;
    try {
      const ret = sess.close();
      if (ret && typeof ret.then === 'function')
        await Promise.race([ret, new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      // 죽은 연결 정리 실패는 치명적이지 않다
    }
  }

  /**
   * 같은 대화를 새 연결로 이어 간다(sessionResumption 핸들).
   * 순서: 옛 연결을 먼저 닫는다(서버가 세션을 놓게) → 핸들로 재접속(상한만큼, 백오프 1/2/4초) → 그래도 안 되면
   * 핸들 없이 새 세션으로 이어 간다(대화 기억은 잃지만 통화는 산다) → 그것마저 실패하면 통화에 `session_lost` 를
   * 알리고 끊는다. 모델만 사라진 채 통화가 무음으로 이어지는 것이 가장 나쁜 실패다.
   *
   * 2026-10-10 실측(Python): setup 이 안 끝나 버린 연결이 서버엔 살아 있어 다음 시도가 1008 "session is already
   * connected to an existing client" 로 거절됐다. 그래서 실패한 시도의 연결도 반드시 닫는다.
   */
  private async _reconnect(reason: string): Promise<boolean> {
    if (this._stopping || this._reconnecting) return !this._stopping;
    this._reconnecting = true;
    const old = this._session;
    this._session = null; // 그동안 feedAudio 는 조용히 버린다
    this._trace('reconnect', { reason, handle: !!this._resumptionHandle });
    this._log.info('Gemini Live reconnecting (%s, resume=%s)', reason, !!this._resumptionHandle);
    await this._closeQuietly(old);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tryConnect = async (): Promise<any | null> => {
      try {
        return await this._connect();
      } catch (err) {
        this._log.warn({ err }, 'Gemini Live reconnect attempt failed');
        return null;
      }
    };
    const adopt = (sess: unknown) => {
      this._session = sess;
      this._pendingToolCall = null;
      this._audioRemainder = Buffer.alloc(0);
    };

    try {
      const attempts = this._reconnectMaxAttempts;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const sess = await tryConnect();
        if (sess) {
          adopt(sess);
          this._trace('reconnected', { attempt, resumed: !!this._resumptionHandle });
          this._log.info(
            'Gemini Live reconnected (attempt %d, resumed=%s)',
            attempt,
            !!this._resumptionHandle,
          );
          return true;
        }
        if (attempt < attempts)
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 4000)));
      }
      if (this._resumptionHandle && !this._stopping) {
        // 핸들 재접속을 포기하고 새 세션으로 이어 간다. systemPrompt·도구는 config 에 있어 그대로다.
        this._log.warn('Gemini Live resume failed; starting a fresh session without context');
        this._resumptionHandle = null;
        const sess = await tryConnect();
        if (sess) {
          adopt(sess);
          this._trace('reconnected', { attempt: attempts + 1, resumed: false });
          this._log.info('Gemini Live reconnected without context (fresh session)');
          return true;
        }
      }
      await this._onSessionLost(`${reason}; reconnect failed after ${attempts} attempts (+fresh)`);
      return false;
    } finally {
      this._reconnecting = false;
    }
  }

  /** 재접속을 포기했다. 통화 쪽에 알리고 끊는다(무음 방치 금지). */
  private async _onSessionLost(reason: string): Promise<void> {
    this._trace('session_lost', { reason });
    this._log.error('Gemini Live session lost: %s — hanging up', reason);
    this._closed = true;
    const call = this._call;
    if (!call || call instanceof BufferingCall) return;
    try {
      call._emit('session_lost', reason);
    } catch (err) {
      this._log.error({ err }, 'session_lost handler failed');
    }
    try {
      await call.hangup();
    } catch (err) {
      this._log.error({ err }, 'hangup after session loss failed');
    }
  }

  /** Attach a real CallSession to the prewarmed session and flush buffered audio. */
  async attach(callSession: CallSession): Promise<void> {
    const prev = this._call;
    this._call = callSession;
    attachBuffered(prev, callSession);
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
    this._stopping = true;
    this._closed = true;
    if (this._toolDrainTimer) {
      clearTimeout(this._toolDrainTimer);
      this._toolDrainTimer = null;
    }
    this._pendingToolCall = null;
    if (this._session) {
      const sess = this._session;
      this._session = null;
      // Best-effort close with a 2s timeout guard so prewarm-then-cancel
      // (missed/declined outbound) doesn't leak the upstream Live session.
      await Promise.race([
        (async () => {
          try {
            const ret = sess.close();
            if (ret && typeof ret.then === 'function') await ret;
          } catch {
            // ignore close errors
          }
        })(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
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
    const builtinDefs = getBuiltinToolSchemas(this._builtinTools, 'gemini');

    this._declaredBehavior.clear();
    this._declaredScheduling.clear();
    for (const def of toolDefs) {
      const name = String(def['name']);
      const tool = this._tools?.get(name);
      const behavior = this._behaviorFor(name, tool?.behavior, false);
      if (behavior) def['behavior'] = behavior;
      this._declaredBehavior.set(name, behavior);
      this._declaredScheduling.set(name, tool?.scheduling ?? null);
    }
    for (const def of builtinDefs) {
      const name = String(def['name']);
      const behavior = this._behaviorFor(name, undefined, true);
      if (behavior) def['behavior'] = behavior;
      this._declaredBehavior.set(name, behavior);
      this._declaredScheduling.set(name, null);
    }
    toolDefs.push(...builtinDefs);
    return toolDefs;
  }

  /**
   * 서버 메시지 하나를 처리한다. `stale` 은 재접속으로 교체된 옛 연결에서 온 메시지다 — 남은 오디오·전사는
   * 그대로 흘리되 goAway·sessionResumptionUpdate·toolCall 같은 제어 메시지는 무시한다(옛 연결의 늦은
   * goAway 가 재접속을 또 일으키거나 옛 핸들이 새 핸들을 덮으면 안 된다).
   */
  private _handleMessage(msg: LiveServerMessage, stale = false): void {
    if (!this._call) return;
    if (TRACE_ENABLED) this._traceMessage(msg);

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

      // 생성 완료 — 오디오는 이 시점에 다 왔다. turnComplete 는 모델이 「재생이 끝났다」고 믿는 시점까지
      // 미뤄지고(모델은 실시간 재생을 가정) 3.8 에선 안 오기도 하므로 여기서도 flush 한다.
      if (serverContent.generationComplete) {
        this._log.debug('Generation complete');
        this._flushAudioRemainder();
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

    if (stale) return;

    // ── 세션 수명 ──
    const upd = msg.sessionResumptionUpdate;
    if (upd?.resumable && upd.newHandle) {
      this._resumptionHandle = upd.newHandle;
      this._trace('session_resumption_update', { handle: upd.newHandle.slice(0, 12) + '…' });
    }
    if (msg.goAway && !this._stopping) {
      this._log.info({ timeLeft: msg.goAway.timeLeft }, 'Gemini goAway received — reconnecting');
      void this._reconnect('go_away');
    }

    // Handle tool calls — NON_BLOCKING 은 즉시, BLOCKING 은 debounce 로 남은 오디오 drain 후 실행
    if (msg.toolCall) {
      const blocking = this._dispatchToolCall(msg.toolCall);
      if (blocking) {
        this._pendingToolCall = blocking;
        this._scheduleToolExecution();
      }
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
      for (const id of toolCancellation.ids ?? []) {
        const entry = this._inflight.get(id);
        if (entry) entry.cancelled = true;
      }
    }
  }

  /**
   * NON_BLOCKING 호출은 즉시 실행하고, BLOCKING 호출만 묶어 돌려준다(drain 뒤 실행).
   * NON_BLOCKING 은 서버가 결과를 기다리지 않고 모델이 계속 말하므로 drain 을 기다릴 이유가 없고,
   * hold audio 도 틀지 않는다(모델 음성과 겹친다).
   */
  private _dispatchToolCall(toolCall: LiveServerToolCall): LiveServerToolCall | null {
    const calls = toolCall.functionCalls ?? [];
    const blocking: typeof calls = [];
    for (const fc of calls) {
      const name = fc.name ?? '';
      if (this._declaredBehavior.get(name) === 'NON_BLOCKING') {
        void this._runAsyncTool(fc);
      } else {
        blocking.push(fc);
      }
    }
    if (blocking.length === 0) return null;
    if (blocking.length === calls.length) return toolCall;
    return { ...toolCall, functionCalls: blocking };
  }

  private async _runAsyncTool(
    fc: NonNullable<LiveServerToolCall['functionCalls']>[number],
  ): Promise<void> {
    const key = fc.id ?? `${fc.name ?? ''}@${Date.now()}`;
    const entry = { cancelled: false };
    this._inflight.set(key, entry);
    try {
      const resp = await this._executeFunctionCall(fc);
      if (resp === 'hang_up' || resp === null) return;
      if (entry.cancelled) {
        this._log.info('NON_BLOCKING tool %s cancelled by server; dropping result', fc.name ?? '');
        return;
      }
      if (this._session && !this._closed) {
        this._trace('tool_response', {
          names: String(resp['name']),
          scheduling: resp['scheduling'],
          mode: 'non_blocking',
        });
        this._session.sendToolResponse({ functionResponses: [resp] });
      }
    } catch (err) {
      this._log.error({ err }, 'NON_BLOCKING tool task failed: %s', fc.name ?? '');
    } finally {
      if (this._inflight.get(key) === entry) this._inflight.delete(key);
    }
  }

  /**
   * 함수 호출 하나를 실행해 FunctionResponse 객체로 만든다. hang_up 이면 'hang_up', 실행할 게 없으면 null.
   * 서버가 id 를 주지 않은 호출에는 id 를 돌려보내지 않는다(우리가 지어낸 id 는 서버가 모른다).
   */
  private async _executeFunctionCall(
    fc: NonNullable<LiveServerToolCall['functionCalls']>[number],
  ): Promise<Record<string, unknown> | 'hang_up' | null> {
    const name = fc.name ?? '';
    const args = fc.args ?? {};
    const base: Record<string, unknown> = { name };
    if (fc.id) base['id'] = fc.id;
    this._log.info({ tool: name, args }, 'Tool call: %s', name);

    const withScheduling = (resp: Record<string, unknown>, resultIsEmpty: boolean) => {
      const scheduling = this._schedulingFor(name, resultIsEmpty);
      if (scheduling) resp['scheduling'] = scheduling;
      return resp;
    };

    // Built-in tools
    if (BUILTIN_TOOL_NAMES.has(name) && this._call && !(this._call instanceof BufferingCall)) {
      const result = await executeBuiltinTool(name, args as Record<string, unknown>, this._call);
      if (result !== null) {
        if (name === 'hang_up') {
          this._log.info('hang_up: ending call');
          return 'hang_up';
        }
        this._log.info('Builtin tool result: %s -> %s', name, result);
        return withScheduling({ ...base, response: { result } }, false);
      }
    }

    // prewarm 창(=상대가 받기 전)에는 통화 제어 도구를 수행할 대상이 없다.
    if (BUILTIN_TOOL_NAMES.has(name) && this._call instanceof BufferingCall) {
      this._log.warn('Builtin tool %s called before answer — deferring', name);
      return withScheduling({ ...base, response: { result: CALL_NOT_READY_RESULT } }, false);
    }

    if (!this._tools || !this._tools.has(name)) {
      this._log.error('Unknown tool: %s', name);
      return withScheduling({ ...base, response: { error: `Unknown tool: ${name}` } }, false);
    }

    try {
      this._call?.recordToolCall();
      const result = await this._tools.call(name, args);
      // undefined/null = 모델에 전할 말이 없다. NON_BLOCKING 이면 SILENT 로 보내 모델이 쓸데없이 답하지 않게 한다.
      const isEmpty = result === undefined || result === null;
      const resultStr = isEmpty
        ? 'ok'
        : typeof result === 'string'
          ? result
          : JSON.stringify(result);
      this._log.info('Tool result: %s -> %s', name, resultStr.substring(0, 200));
      return withScheduling({ ...base, response: { result: resultStr } }, isEmpty);
    } catch (err) {
      this._log.error({ err }, 'Tool call failed: %s', name);
      if (err instanceof Error) {
        this._call?.recordToolError(err);
      }
      return withScheduling({ ...base, response: { error: String(err) } }, false);
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

  /** BLOCKING 호출 묶음을 실행한다. 모델이 결과를 기다리므로 그동안 hold audio 를 튼다. */
  private async _handleToolCall(toolCall: LiveServerToolCall): Promise<void> {
    const functionCalls = toolCall.functionCalls;
    if (!functionCalls) return;

    const responses: Array<Record<string, unknown>> = [];

    const player =
      this._holdAudioChunks &&
      this._call &&
      !(this._call instanceof BufferingCall) &&
      holdAudioAllowed(functionCalls.map((fc) => fc.name ?? ''))
        ? new HoldAudioPlayer(this._call, this._holdAudioChunks)
        : null;
    player?.start();

    try {
      for (const fc of functionCalls) {
        const resp = await this._executeFunctionCall(fc);
        if (resp === 'hang_up') return;
        if (resp !== null) responses.push(resp);
      }
    } finally {
      player?.stop();
    }

    if (responses.length > 0 && this._session) {
      this._log.debug('Sending %d tool response(s)', responses.length);
      this._trace('tool_response', {
        names: responses.map((r) => String(r['name'])).join(','),
        mode: 'blocking',
      });
      this._session.sendToolResponse({
        functionResponses: responses,
      });
    }
  }
}
