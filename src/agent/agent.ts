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
   * AMD (Answering Machine Detection). Instance-wide default for `call()`.
   * - 'Enable': run AMD, deliver AnsweredBy via webhook, continue the call (Twilio-style)
   * - 'Hangup': run AMD, auto-hangup on machine + billed_duration=0 (Vonage-style)
   * - undefined: AMD disabled (default behaviour preserved)
   */
  machineDetection?: MachineDetection;
}

export type MachineDetection = 'Enable' | 'Hangup';

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
  private _machineDetection?: MachineDetection;
  private _prewarmTasks = new Map<string, Promise<void>>();
  private _prewarmFailed = new Set<string>();

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
   * Matches Python SDK: agent.call(to, { timeout })
   */
  async call(
    to: string,
    options?: { timeout?: number; machineDetection?: MachineDetection },
  ): Promise<CallSession> {
    await this.connect();

    const url = `${this._baseUrl}/v1/accounts/${this._accountId}/calls`;
    // Call-level override > instance default > undefined.
    const effectiveMd = options?.machineDetection ?? this._machineDetection;
    const body: Record<string, unknown> = {
      To: to,
      From: this._fromNumber,
      Timeout: options?.timeout ?? 60,
    };
    if (effectiveMd) body['MachineDetection'] = effectiveMd;
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

    // Kick off LLM prewarm in parallel with media WS setup. This shaves the
    // LLM connect + session.update RTT off the user-perceived first-audio
    // latency. _startCallSession awaits this task and uses attach() instead
    // of start() when it resolves.
    this._startPrewarm(callId);

    if (mediaUrl) {
      this._log.info('Outbound call answered: %s -> %s (%s)', this._fromNumber, session.toNumber, callId);
      this._safeStartCallSession(session, mediaUrl, callId);
    }
  }

  /**
   * Start the LLM session prewarm task for the given callId. Safe to call
   * multiple times — only the first invocation starts the task.
   */
  private _startPrewarm(callId: string): void {
    if (this._prewarmTasks.has(callId)) return;
    const sessionHandler = this._session;
    if (typeof sessionHandler.prewarm !== 'function') return;

    const task = (async () => {
      try {
        const PREWARM_TIMEOUT_MS = 10_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('prewarm timeout')), PREWARM_TIMEOUT_MS);
        });
        try {
          await Promise.race([sessionHandler.prewarm(), timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (err) {
        this._log.warn({ err, callId }, 'prewarm failed; will fall back to start()');
        this._prewarmFailed.add(callId);
      }
    })();
    this._prewarmTasks.set(callId, task);
  }

  private _handleRinging(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const session = this._activeSessions.get(callId);
    if (session) {
      this._log.info('Outbound call ringing: %s', callId);
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

          // Start the session handler
          await sessionHandler.start(session, sessionTools);

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
