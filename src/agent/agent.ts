/**
 * ClawOpsAgent - main agent class for handling voice calls.
 */

import { DEFAULT_BASE_URL } from '../constants.js';
import { AgentConnectionError, AgentError } from '../error.js';
import { applyUlawGain, ulawToPcm16 } from './audio.js';
import { ControlWebSocket } from './control-ws.js';
import type { ControlEvent } from './control-ws.js';
import { MCPClient } from './mcp/client.js';
import type { MCPServerStdio, MCPServerHTTP } from './mcp/index.js';
import { MediaWebSocket } from './media-ws.js';
import { AudioRecorder } from './recorder.js';
import { CallSession } from './session.js';
import { BuiltinTool, resolveBuiltinTools } from './builtin-tool.js';
import { loadHoldAudio } from './hold-audio.js';
import { ToolRegistry } from './tool.js';
import type { FunctionTool } from './tool.js';
import type { Session } from './pipeline/base.js';
import { getSdkInfo } from './telemetry.js';
import { setTracingConfig } from './tracing/config.js';
import type { TracingConfig } from './tracing/config.js';
import { withSpan } from './tracing/spans.js';
import { ATTR_CALL_ID, ATTR_CALL_DIRECTION, ATTR_AGENT_ID } from './tracing/attributes.js';
import type { Logger } from 'pino';
import { createAgentLogger, createPipelineLogger } from './logger.js';

export type AgentEventType = 'call_start' | 'call_end' | 'call_failed' | 'transcript' | 'dtmf';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentEventHandler = (...args: any[]) => void | Promise<void>;

/** Tool 실행 관련 설정. */
export interface ToolConfig {
  /** Tool 실행 중 재생할 hold audio. true=기본 차임, string=wav 파일 경로, Buffer=raw ulaw. */
  holdAudio?: boolean | string | Buffer;
}

export interface ClawOpsAgentOptions {
  /** ClawOps API key. Falls back to CLAWOPS_API_KEY env var. */
  apiKey?: string;
  /** Account ID. Falls back to CLAWOPS_ACCOUNT_ID env var. */
  accountId?: string;
  /** API base URL. */
  baseUrl?: string;
  /** Phone number to send/receive calls from. Required. */
  from: string;
  /** Session implementation (OpenAIRealtime, GeminiRealtime, PipelineSession, etc.). */
  session: Session;
  /** Enable call recording. */
  recording?: boolean;
  /** Recording output directory. Default: './recordings' */
  recordingPath?: string;
  /** MCP server configurations. */
  mcpServers?: Array<MCPServerStdio | MCPServerHTTP>;
  /** Tracing configuration. */
  tracing?: TracingConfig;
  /** 활성화할 내장 도구. Default: BuiltinTool.ALL */
  builtinTools?: BuiltinTool | BuiltinTool[];
  /** Debounce time (ms) for passive DTMF accumulation. Default: 500 */
  passiveDtmfDebounceMs?: number;
  /** Custom pino logger instance. If omitted, a default logger is created. */
  logger?: Logger;
  /** Tool 실행 관련 설정. */
  toolConfig?: ToolConfig;
  /**
   * Gain applied to inbound audio (caller → AI). 1.0 = pass-through (default), 0 = mute, 2.0 = 2x amplify.
   * AI/STT receive the gained audio, and recording captures it post-gain.
   */
  rxGain?: number;
  /**
   * Gain applied to outbound audio (AI → caller). 1.0 = pass-through (default), 0 = mute, 2.0 = 2x amplify.
   * The caller hears the gained audio, and recording captures it post-gain.
   */
  txGain?: number;
  /**
   * outbound_ready 시점에 session.prewarm() 을 백그라운드로 시작할지 여부.
   * false 면 기존 start() 단일 경로로 동작 (prewarm 비활성). Default: true.
   * Python SDK 의 `prewarm_enabled` 과 mirror.
   */
  prewarmEnabled?: boolean;
  /**
   * 이 에이전트의 모든 발신에 적용되는 AMD(machineDetection) default.
   * `'Enable'`=감지 후 `AnsweredBy` 통보(통화 계속), `'Hangup'`=음성사서함 감지 시 자동 종료.
   * `call(to, { machineDetection })` 로 호출별 override 가능.
   * 우선순위: 호출 인자 > 인스턴스 default > 비활성. Python SDK 의 `machine_detection` 과 mirror.
   */
  machineDetection?: 'Enable' | 'Hangup';
}

export class ClawOpsAgent {
  private _apiKey: string;
  private _accountId: string;
  private _baseUrl: string;
  private _fromNumber: string;
  private _session: Session;
  private _tools: ToolRegistry = new ToolRegistry();
  private _handlers: Map<string, AgentEventHandler[]> = new Map();
  private _controlWs: ControlWebSocket | null = null;
  private _mcpServers: Array<MCPServerStdio | MCPServerHTTP>;
  private _recording: boolean;
  private _recordingPath: string;
  private _activeSessions: Map<string, CallSession> = new Map();
  private _builtinTools!: Set<BuiltinTool>;
  private _passiveDtmfDebounceMs: number;
  private _passiveDtmfBuffer: string[] = [];
  private _passiveDtmfTimer: ReturnType<typeof setTimeout> | null = null;
  private _passiveDtmfCallId: string | null = null;
  private _callSessions = new Map<string, Session>();
  private _log: Logger;
  private _pipelineLog: Logger;
  private _isPipelineSession = false;
  private _holdAudioChunks: Buffer[] | null = null;
  private _rxGain: number;
  private _txGain: number;
  private _prewarmTasks = new Map<string, Promise<void>>();
  private _prewarmFailed = new Set<string>();
  /** prewarm 세션이 실제 CallSession 에 attach 완료된 callId. attached 이후의 stop() 은 정상 종료 경로가 책임진다. */
  private _prewarmAttached = new Set<string>();
  private _prewarmEnabled: boolean;
  /** 모든 발신에 적용되는 AMD default. call() 인자로 호출별 override 가능. */
  private _machineDetection?: 'Enable' | 'Hangup';

  constructor(options: ClawOpsAgentOptions) {
    this._apiKey = options.apiKey ?? process.env['CLAWOPS_API_KEY'] ?? '';
    this._accountId = options.accountId ?? process.env['CLAWOPS_ACCOUNT_ID'] ?? '';
    this._baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this._fromNumber = options.from;
    this._session = options.session;
    this._recording = options.recording ?? false;
    this._recordingPath = options.recordingPath ?? './recordings';
    this._mcpServers = options.mcpServers ?? [];
    this._builtinTools = resolveBuiltinTools(options.builtinTools ?? BuiltinTool.ALL);
    this._passiveDtmfDebounceMs = options.passiveDtmfDebounceMs ?? 500;
    this._rxGain = ClawOpsAgent._validateGain('rxGain', options.rxGain ?? 1.0);
    this._txGain = ClawOpsAgent._validateGain('txGain', options.txGain ?? 1.0);
    this._prewarmEnabled = options.prewarmEnabled ?? true;
    this._machineDetection = options.machineDetection;

    // Configure tracing
    if (options.tracing) {
      setTracingConfig(options.tracing);
    }

    this._log = createAgentLogger(options.logger);
    this._pipelineLog = createPipelineLogger(this._log);
    // Detect PipelineSession at construction time (duck-type check)
    this._isPipelineSession = '_stt' in this._session && '_llm' in this._session;

    if (options.toolConfig?.holdAudio) {
      this._holdAudioChunks = loadHoldAudio(options.toolConfig.holdAudio as true | string | Buffer);
    }
  }

  private static _validateGain(name: string, gain: number): number {
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0) {
      throw new AgentError(`${name}=${gain} must be a finite number >= 0`);
    }
    return gain;
  }

  /**
   * Register a function tool.
   *
   * Supports two signatures (matching Python SDK):
   *   agent.tool(name, description, parameters, handler)
   *   agent.tool(functionToolObject)
   */
  tool(
    nameOrTool: string | FunctionTool,
    description?: string,
    parameters?: Record<string, unknown>,
    handler?: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  ): this {
    if (typeof nameOrTool === 'string') {
      if (!description || !parameters || !handler) {
        throw new AgentError(
          'tool(name, description, parameters, handler) requires all arguments.',
        );
      }
      this._tools.register({
        name: nameOrTool,
        description,
        parameters,
        required: Object.keys(parameters),
        handler,
      });
    } else {
      this._tools.register(nameOrTool);
    }
    return this;
  }

  /**
   * Register an event handler.
   *
   * Matches Python SDK decorator style:
   *   agent.on("call_start", (call) => { ... })
   *   agent.on("transcript", (call, role, text) => { ... })
   */
  on(event: AgentEventType, handler: AgentEventHandler): this {
    let list = this._handlers.get(event);
    if (!list) {
      list = [];
      this._handlers.set(event, list);
    }
    list.push(handler);
    return this;
  }

  /** Connect to the ClawOps platform and start listening for calls. */
  async connect(): Promise<void> {
    if (this._controlWs) return;

    if (!this._apiKey) {
      throw new AgentError('API key is required. Set CLAWOPS_API_KEY or pass apiKey option.');
    }
    if (!this._accountId) {
      throw new AgentError(
        'Account ID is required. Set CLAWOPS_ACCOUNT_ID or pass accountId option.',
      );
    }

    // Connect control WebSocket
    this._controlWs = new ControlWebSocket({
      baseUrl: this._baseUrl,
      apiKey: this._apiKey,
      accountId: this._accountId,
      number: this._fromNumber,
    });

    this._controlWs.setLogger(this._log);

    this._controlWs.on('call.incoming', (event) => this._handleIncoming(event));
    this._controlWs.on('call.ended', (event) => this._handleEnded(event));
    this._controlWs.on('call.outbound_ready', (event) => this._handleOutboundReady(event));
    this._controlWs.on('call.ringing', (event) => this._handleRinging(event));
    this._controlWs.on('call.failed', (event) => this._handleFailed(event));

    try {
      await this._controlWs.connect();
      await this._controlWs.waitConnected();
      try {
        this._controlWs.send({ event: 'agent.hello', sdk: getSdkInfo() });
      } catch { /* best-effort */ }
    } catch (err) {
      throw new AgentConnectionError(
        `Failed to connect to ClawOps: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this._log.info('ClawOpsAgent connected on %s', this._fromNumber);
  }

  /**
   * Connect and block until disconnected.
   * Convenience method for simple agent scripts.
   */
  async serve(): Promise<void> {
    await this.connect();

    // Block indefinitely until process signal
    return new Promise<void>((resolve) => {
      const shutdown = () => {
        this.disconnect()
          .then(resolve)
          .catch(() => resolve());
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  }

  /** Disconnect from the platform. */
  async disconnect(): Promise<void> {
    if (this._controlWs) {
      this._controlWs.close();
      this._controlWs = null;
    }

    for (const session of this._activeSessions.values()) {
      session._markEnded();
    }
    this._activeSessions.clear();
    this._callSessions.clear();
    this._log.info('ClawOpsAgent disconnected');
  }

  /**
   * Initiate an outbound call.
   * Matches Python SDK: agent.call(to, { timeout, machineDetection })
   *
   * @param options.machineDetection 자동응답기/음성사서함 감지(AMD).
   *   `'Enable'`=감지 후 `AnsweredBy` 통보(통화 계속), `'Hangup'`=음성사서함 감지 시 자동 종료.
   *   미지정 시 인스턴스 default(생성자의 `machineDetection`)를 따른다.
   *   우선순위: 호출 인자 > 인스턴스 default > 비활성.
   */
  async call(
    to: string,
    options?: { timeout?: number; machineDetection?: 'Enable' | 'Hangup' },
  ): Promise<CallSession> {
    await this.connect();

    const url = `${this._baseUrl}/v1/accounts/${this._accountId}/calls`;
    const body: Record<string, unknown> = {
      To: to,
      From: this._fromNumber,
      Timeout: options?.timeout ?? 60,
    };
    const effectiveMd = options?.machineDetection ?? this._machineDetection;
    if (effectiveMd) {
      body['MachineDetection'] = effectiveMd;
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (resp.status !== 201) {
      const error = (await resp.json()) as Record<string, unknown>;
      throw new AgentError(`발신 실패 (${resp.status}): ${(error['error'] as string) ?? ''}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;

    const callSession = new CallSession({
      callId: data['callId'] as string,
      fromNumber: this._fromNumber,
      toNumber: to,
      accountId: this._accountId,
      direction: 'outbound',
    });

    // Register all agent-level event handlers on the session
    for (const [evt, handlers] of this._handlers) {
      for (const handler of handlers) {
        callSession.on(evt, handler);
      }
    }

    callSession.setLogger(this._log);
    this._activeSessions.set(callSession.callId, callSession);
    this._log.info('Outbound call initiated: %s -> %s (%s)', this._fromNumber, to, callSession.callId);

    // originate 직후 prewarm 을 시작한다 — ring 구간(answer 이전)에 LLM 연결 +
    // greeting 생성을 흡수해 answer→first-audio latency 를 줄인다. call.ringing
    // 이벤트는 트렁크가 SIP 18x 를 안 올리면 도착하지 않을 수 있어 신뢰하지 않는다.
    // ringing/outbound_ready 핸들러의 prewarm 시작은 이 시점을 놓쳤을 때의 fallback.
    if (this._prewarmEnabled) {
      this._startPrewarm(callSession.callId);
    }

    return callSession;
  }

  private _handleIncoming(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const fromNumber = (event['from'] as string) ?? '';
    const mediaUrl = (event['mediaUrl'] as string) ?? '';

    const session = new CallSession({
      callId,
      fromNumber,
      toNumber: this._fromNumber,
      accountId: this._accountId,
      direction: 'inbound',
    });

    // Register all agent-level event handlers on the session
    for (const [evt, handlers] of this._handlers) {
      for (const handler of handlers) {
        session.on(evt, handler);
      }
    }

    session.setLogger(this._log);
    this._activeSessions.set(callId, session);
    this._log.info('Incoming call: %s -> %s (%s)', fromNumber, this._fromNumber, callId);

    // Accept the call
    if (this._controlWs) {
      this._controlWs.send({ event: 'call.accept', callId });
    }

    if (mediaUrl) {
      this._safeStartCallSession(session, mediaUrl, callId);
    }
  }

  private _handleEnded(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const session = this._activeSessions.get(callId);
    if (session) {
      this._log.info('Call ended (server): %s', callId);
      session._markEnded();
      this._activeSessions.delete(callId);
    }
    void this._cleanupPrewarm(callId);
  }

  /**
   * Drop prewarm bookkeeping for a callId. Used on hangup/failure paths.
   *
   * prewarm 이 진행 중이거나 완료됐지만 attach 전에 호출되면 LLM WS 가 leak 되므로
   * race 후 session.stop() 으로 정리한다. (TS 에는 Promise.cancel 이 없어 Python
   * 의 task.cancel() 등가물은 _session.stop() 호출이다.)
   *
   * 이미 attach 된 callId 면 stop() 을 호출하지 않는다 — 정상 종료 경로 (call-session
   * finally) 가 책임지기 때문이다.
   */
  private async _cleanupPrewarm(callId: string): Promise<void> {
    const task = this._prewarmTasks.get(callId);
    const attached = this._prewarmAttached.has(callId);
    this._prewarmTasks.delete(callId);
    this._prewarmFailed.delete(callId);
    this._prewarmAttached.delete(callId);
    if (!task || attached) return;
    // prewarm 미완료 → 완료까지 await 한 뒤 stop(); 실패 시에도 stop() 시도.
    try {
      await task;
    } catch {
      /* prewarm error path already logged */
    }
    try {
      await this._session.stop();
    } catch (err) {
      this._log.warn({ err, callId }, 'prewarm cleanup stop() failed');
    }
  }

  private _handleOutboundReady(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const mediaUrl = (event['mediaUrl'] as string) ?? '';
    let session = this._activeSessions.get(callId);

    if (!session) {
      session = new CallSession({
        callId,
        fromNumber: this._fromNumber,
        toNumber: (event['to'] as string) ?? '',
        accountId: this._accountId,
        direction: 'outbound',
      });
      session.setLogger(this._log);

      // Register all agent-level event handlers on the session
      for (const [evt, handlers] of this._handlers) {
        for (const handler of handlers) {
          session.on(evt, handler);
        }
      }

      this._activeSessions.set(callId, session);
    }

    // prewarm 은 보통 _handleRinging(ring 구간)에서 이미 시작됐다. _startPrewarm 은
    // idempotent 하므로 여기서의 호출은 ringing 이 오지 않은 경우의 fallback 으로만
    // 동작한다. _startCallSession 이 이 task 를 await 후 attach() 로 부착한다.
    // prewarmEnabled=false 면 skip → 기존 start() 경로.
    if (this._prewarmEnabled) {
      this._startPrewarm(callId);
    }

    if (mediaUrl) {
      this._log.info('Outbound call answered: %s -> %s (%s)', this._fromNumber, session.toNumber, callId);
      this._safeStartCallSession(session, mediaUrl, callId);
    }
  }

  /**
   * Start the LLM session prewarm task for the given callId. Safe to call
   * multiple times — only the first invocation starts the task. Failures are
   * recorded in _prewarmFailed so the call-session path can fall back to start().
   */
  private _startPrewarm(callId: string): void {
    if (this._prewarmTasks.has(callId)) return;
    const sessionHandler = this._session;
    if (typeof sessionHandler.prewarm !== 'function') return;

    const PREWARM_TIMEOUT_MS = 10_000;
    const t0 = Date.now();
    this._log.info(`[PREWARM-T] start call_id=${callId} t=${(t0 / 1000).toFixed(3)}`);
    const task = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('prewarm timeout')),
            PREWARM_TIMEOUT_MS,
          );
        });
        await Promise.race([sessionHandler.prewarm(), timeout]);
        const elapsed = Date.now() - t0;
        this._log.info(`[PREWARM-T] done call_id=${callId} elapsed_ms=${elapsed}`);
      } catch (err) {
        const elapsed = Date.now() - t0;
        const reason = err instanceof Error ? err.message : String(err);
        this._log.warn(
          { err, callId },
          `[PREWARM-T] failed call_id=${callId} elapsed_ms=${elapsed} reason=${reason}`,
        );
        this._prewarmFailed.add(callId);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    this._prewarmTasks.set(callId, task);
  }

  private _handleRinging(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const session = this._activeSessions.get(callId);
    if (session) {
      this._log.info('Outbound call ringing: %s', callId);

      // ring 구간(answer 이전)에 prewarm 을 미리 시작한다 — LLM WS 연결 +
      // greeting 생성을 ring 시간으로 흡수해 answer→first-audio latency 를 줄인다.
      // outbound_ready 에서의 prewarm 시작은 ringing 이 안 온 경우의 fallback.
      if (this._prewarmEnabled) {
        this._startPrewarm(callId);
      }
    }
  }

  private _handleFailed(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const session = this._activeSessions.get(callId);
    if (session) {
      this._log.info('Outbound call failed: %s (%s)', callId, (event['reason'] as string) ?? 'failed');
      session._emit('call_failed', (event['reason'] as string) ?? 'failed');
      session._markEnded();
      this._activeSessions.delete(callId);
    }
    void this._cleanupPrewarm(callId);
  }

  private _onDtmfEvent(callSession: CallSession, digit: string): void {
    callSession._emit('dtmf', digit);

    // Always route to session buffer — collector may not be active yet (tool call timing)
    callSession._routeDtmf(digit);

    if ((callSession as any)._dtmfCollectorActive) {
      callSession.clearAudio();
      return;
    }

    this._passiveDtmfBuffer.push(digit);
    this._passiveDtmfCallId = callSession.callId;
    if (this._passiveDtmfTimer) {
      clearTimeout(this._passiveDtmfTimer);
    }
    this._passiveDtmfTimer = setTimeout(() => {
      const digits = this._passiveDtmfBuffer.join('');
      this._passiveDtmfBuffer = [];
      const sessionHandler = this._passiveDtmfCallId
        ? this._callSessions.get(this._passiveDtmfCallId)
        : null;
      this._passiveDtmfCallId = null;
      if (digits && sessionHandler && sessionHandler.feedDtmf) {
        sessionHandler.feedDtmf(digits).catch((err: unknown) => {
          this._log.error({ err }, 'DTMF feed error');
        });
      }
    }, this._passiveDtmfDebounceMs);
  }

  /**
   * _startCallSession 의 예외를 잡아 control WS 로 call.session_failed 전송한다.
   *
   * OpenAI/Gemini API 키 누락 등 session.start() 단계 실패는 media WS connect 에
   * 도달하지 못해 call-engine 이 30 초간 무음 통화를 유지하게 만든다. 서버에 즉시
   * 알려서 fail-fast 시키고 _activeSessions 에서 정리한다.
   */
  private _safeStartCallSession(session: CallSession, mediaWsUrl: string, callId: string): void {
    this._startCallSession(session, mediaWsUrl).catch((err: unknown) => {
      const error = err as Error;
      this._log.error({ err }, 'Session start failed for %s', callId);
      if (this._controlWs) {
        try {
          this._controlWs.send({
            event: 'call.session_failed',
            callId,
            reason: error?.name ?? 'Error',
            message: error?.message ?? String(err),
          });
        } catch {
          // best-effort
        }
      }
      this._activeSessions.delete(callId);
      this._callSessions.delete(callId);
    });
  }

  private async _startCallSession(session: CallSession, mediaWsUrl: string): Promise<void> {
    await withSpan(
      'clawops.call_session',
      {
        [ATTR_CALL_ID]: session.callId,
        [ATTR_CALL_DIRECTION]: session.direction,
        [ATTR_AGENT_ID]: this._accountId,
      },
      async () => {
        // Fork tools for this session (per-call MCP isolation)
        const sessionTools = this._tools.fork();

        // MCP: start servers per call
        const mcpClients: MCPClient[] = [];
        if (this._mcpServers.length > 0) {
          for (const serverConfig of this._mcpServers) {
            const client = new MCPClient();
            client.setLogger(this._log);
            client.addServer('mcp', serverConfig);
            try {
              const tools = await client.connect();
              sessionTools.registerMcpTools(tools);
              mcpClients.push(client);
            } catch (err) {
              this._log.error({ err }, 'MCP connection error');
            }
          }
        }

        // Set up recorder if configured
        let recorder: AudioRecorder | null = null;
        if (this._recording) {
          recorder = new AudioRecorder(this._recordingPath, session.callId);
          recorder.setLogger(this._log);
          recorder.start();
        }

        // Connect media WebSocket
        const mediaWs = new MediaWebSocket();
        mediaWs.setLogger(this._log);

        let latestMediaTs = 0;

        // Bind transport functions to session — sessions send ulaw bytes directly
        session._bindTransport(
          (audio: Buffer) => {
            const gained = applyUlawGain(audio, this._txGain);
            if (recorder) {
              recorder.writeOutbound(ulawToPcm16(gained), latestMediaTs);
            }
            mediaWs.sendAudio(gained.toString('base64'));
            session.recordFirstResponse();
          },
          () => {
            mediaWs.sendClear();
            session.recordBargeIn();
          },
          async () => {
            await mediaWs.flush();
            const markName = `hangup-${Date.now()}`;
            mediaWs.sendMark(markName);
            await mediaWs.waitForMark(markName, 5000);
            mediaWs.close();
          },
          async (digit: string) => {
            mediaWs.sendDtmf(digit);
          },
          () => mediaWs.isConnected,
        );

        session._transferFn = (params) => this._controlWs!.requestTransfer(session.callId, params);

        // Media WS mark/flush 를 세션에 노출 — LiveKit ClawOpsAudioOutput 이 재생 완료
        // (mark echo) 판정과 barge-in 절단 위치 계산에 쓴다. native 세션은 읽지 않는다.
        session._sendMark = (name: string) => mediaWs.sendMark(name);
        session._waitForMark = (name: string, timeoutMs: number) => mediaWs.waitForMark(name, timeoutMs);
        session._flushTransport = () => mediaWs.flush();

        const sessionHandler = this._session;

        // Inject tools and recorder into session if supported
        if (
          'setToolRegistry' in sessionHandler &&
          typeof sessionHandler.setToolRegistry === 'function'
        ) {
          sessionHandler.setToolRegistry(sessionTools);
        }
        if (
          recorder &&
          'setRecorder' in sessionHandler &&
          typeof sessionHandler.setRecorder === 'function'
        ) {
          sessionHandler.setRecorder(recorder);
        }
        if ('setBuiltinTools' in sessionHandler && typeof sessionHandler.setBuiltinTools === 'function') {
          (sessionHandler as any).setBuiltinTools(this._builtinTools);
        }
        if ('setLogger' in sessionHandler && typeof sessionHandler.setLogger === 'function') {
          sessionHandler.setLogger(this._isPipelineSession ? this._pipelineLog : this._log);
        }
        if (
          this._holdAudioChunks &&
          'setHoldAudio' in sessionHandler &&
          typeof sessionHandler.setHoldAudio === 'function'
        ) {
          sessionHandler.setHoldAudio(this._holdAudioChunks);
        }

        // Save session handler for DTMF routing
        this._callSessions.set(session.callId, sessionHandler);

        // Handle inbound audio — feed raw ulaw to session (each session converts as needed)
        mediaWs.onAudio((ulawAudio: Buffer, timestamp: number) => {
          latestMediaTs = timestamp;
          const gained = applyUlawGain(ulawAudio, this._rxGain);
          if (recorder) {
            recorder.writeInbound(ulawToPcm16(gained), timestamp);
          }
          if (sessionHandler) {
            sessionHandler.feedAudio(gained, timestamp);
          }
        });

        // Handle inbound DTMF
        mediaWs.onDtmf((digit: string) => {
          this._onDtmfEvent(session, digit);
        });

        mediaWs.onClose(() => {
          this._log.info('Media stream stopped: %s', session.callId);
          if (recorder) {
            recorder.stop();
          }
          session._markEnded();
        });

        // Emit call_start
        session._emit('call_start');

        try {
          await mediaWs.connect(mediaWsUrl, this._apiKey);
          this._log.info('Media stream started: %s', session.callId);

          // If a prewarm task was kicked off earlier (outbound_ready hook),
          // await it and then attach() instead of doing a full start(). This
          // trims the LLM connect + handshake off the perceived first-audio
          // latency. Falls back to start() if prewarm failed/timed out.
          const prewarmTask = this._prewarmTasks.get(session.callId);
          if (prewarmTask && !this._prewarmFailed.has(session.callId)) {
            try {
              await prewarmTask;
              if (this._prewarmFailed.has(session.callId)) {
                await sessionHandler.start(session, sessionTools);
              } else {
                this._log.info(
                  `[PREWARM-T] attach call_id=${session.callId} t=${(Date.now() / 1000).toFixed(3)}`,
                );
                await sessionHandler.attach(session);
                this._prewarmAttached.add(session.callId);
              }
            } catch (err) {
              this._log.warn(
                { err, callId: session.callId },
                'prewarm/attach failed, falling back to start()',
              );
              // attach() throw 시 prewarmed LLM 세션이 살아있다. 두 번째 start() 가
              // 새 WS 를 열어 첫 세션이 leak 되지 않도록 먼저 stop() 정리.
              try { await sessionHandler.stop(); } catch { /* best-effort */ }
              await sessionHandler.start(session, sessionTools);
            }
          } else {
            await sessionHandler.start(session, sessionTools);
          }
          // 정상 경로에서는 attached 플래그를 정상 종료가 책임지지만, bookkeeping 만 정리.
          this._prewarmTasks.delete(session.callId);
          this._prewarmFailed.delete(session.callId);
          this._prewarmAttached.delete(session.callId);

          // Send session telemetry
          const telemetry = sessionHandler.getTelemetry?.() ?? null;
          if (telemetry) {
            telemetry.toolCount = sessionTools?.size ?? 0;
            telemetry.mcpServerCount = this._mcpServers?.length ?? 0;
            telemetry.builtinTools = this._builtinTools ? [...this._builtinTools].map(t => t.toString()) : [];
            telemetry.recordingEnabled = this._recording;
            try {
              this._controlWs!.send({ event: 'call.telemetry', callId: session.callId, telemetry });
            } catch { /* best-effort */ }
          }

          // Wait for the call to end
          await session.wait();

          // Stop the session handler
          await sessionHandler.stop();
        } catch (err) {
          this._log.error({ err }, 'Call session error: %s', session.callId);
          session.recordEndReason('error');
        } finally {
          // Clean up MCP clients
          if (mcpClients.length > 0) {
            sessionTools.clearMcpTools();
            for (const c of mcpClients) {
              await c.disconnect();
            }
          }

          mediaWs.close();
          if (recorder) {
            recorder.stop();
          }

          // Determine end reason and send metrics
          if (!session.metrics.endReason) {
            session.recordEndReason(session.status === 'ended' ? 'user_hangup' : 'agent_hangup');
          }
          try {
            this._controlWs?.send({ event: 'call.metrics', callId: session.callId, metrics: session.metrics });
          } catch { /* best-effort */ }

          // Emit call_end
          session._emit('call_end');
          session._markEnded();
          this._activeSessions.delete(session.callId);
          this._callSessions.delete(session.callId);
        }
      },
    );
  }
}
