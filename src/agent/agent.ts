/**
 * ClawOpsAgent - main agent class for handling voice calls.
 */

import { DEFAULT_BASE_URL } from '../constants.js';
import { AgentConnectionError, AgentError } from '../error.js';
import { applyUlawGain, ulawToPcm16 } from './audio.js';
import { CLOSE_REPLACED, ControlWebSocket } from './control-ws.js';
import {
  clearStaleReadyMarker,
  removeReadyMarker,
  takeStaleClearNotice,
  warnIfSignalsBlocked,
  writeReadyMarker,
} from './deploy-checks.js';
import { startHealthServer } from './health.js';
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

/**
 * 미디어 정리 후 서버 종료 프레임을 기다리는 상한(ms). 정상 경로에서는 밀리초 안에 풀리고,
 * 제어 연결이 죽어 프레임이 아예 안 올 때만 이 값을 다 쓴다.
 *
 * 🔴 이건 **임시 장치**다. 서버가 미디어 WS 를 먼저 닫고 정리를 마친 뒤에 종료 프레임을
 *    보내기 때문에 클라이언트가 그 순서를 보정하고 있다. 서버가 종료 프레임을 미디어 WS
 *    닫기 **전에** 보내게 되면 이 대기는 통째로 필요 없어진다. 다만 그때도 구 서버가 남아
 *    있는 동안은 유지해야 한다 — 버전 협상이 없어 "모두 새 서버" 를 확신할 방법이 없다.
 */
const TERMINAL_FRAME_GRACE_MS = 2000;

/**
 * How long `drain()` waits for in-flight calls before cutting them. **Unbounded by default.**
 *
 * This used to be 120s — a number that came from the ECS `stopTimeout` ceiling and was then
 * applied to k8s as well, where `terminationGracePeriodSeconds` has no ceiling at all. Measured
 * against real traffic, **29.8% of in-flight calls (464/1,559) run past 110s.** We were cutting
 * calls that would have finished on their own.
 *
 * The only thing that ends a call now is the platform SIGKILL. On a short grace period (ECS) that
 * grace *is* the deadline, so there is nothing to count here; on a long one (k8s) waiting for the
 * call to finish is the whole point. Pass an explicit value to cut before the grace period.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = Infinity;
/** How often `drain()` re-checks whether the last call has ended. */
const DRAIN_POLL_INTERVAL_MS = 200;

/**
 * How long to keep holding the slot after SIGTERM, waiting for a successor to take over.
 *
 * This wait is what removes the gap in a deploy. Before it, the slot was released the moment
 * SIGTERM arrived, and every call that came in before the successor connected died — a
 * readinessProbe was the workaround that stopped the orchestrator from ever reaching that
 * moment.
 *
 * ⚠ It has to be short. **When there is no successor this wait is a loss** — on a scale-in or a
 *   plain stop, releasing the slot immediately (as before) is better: calls after that simply
 *   do not connect. A call accepted during this wait and then cut at the grace deadline is worse.
 */
const DEFAULT_HANDOVER_WAIT_MS = 20_000;

/**
 * Absolute deadline from SIGTERM. The handover wait and the drain share this one budget.
 * **Unbounded by default** — same reason as `DEFAULT_DRAIN_TIMEOUT_MS`.
 *
 * It used to be 110s (ECS `stopTimeout` 120s minus 10s of cleanup slack). That value was applied
 * to k8s too, so calls were cut at 110s even where the grace period was generous.
 *
 * When a finite deadline *is* given the contract is unchanged: the two phases **share** it rather
 * than adding up. A handover that finishes in 2s leaves the rest for draining; one that uses the
 * full 20s leaves that much less. Adding them would overshoot the platform grace period and the
 * SIGKILL would cut the calls anyway.
 */
const DEFAULT_SHUTDOWN_DEADLINE_MS = Infinity;

/** A one-shot flag you can also await. */
function latch(): { promise: Promise<void>; set: () => void; done: boolean } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const l = {
    promise,
    done: false,
    set: () => {
      if (l.done) return;
      l.done = true;
      resolve();
    },
  };
  return l;
}

/** Resolve as soon as any of the promises does, or when the budget runs out. */
async function firstOf(promises: Promise<void>[], timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([...promises, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
   * Called when another process takes over this number's control connection — the normal
   * middle of a rolling deploy, seen from the instance being replaced. New calls already go
   * elsewhere; finish the calls still in flight and exit. `serve()` handles this for you;
   * wire this only if you drive `connect()` yourself, and call `drain()` from it.
   */
  onTakenOver?: (info: { code: number; reason: string }) => void;
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
  /** Set once the server hands this number to another process (rolling deploy takeover). */
  private _takenOver = false;
  /**
   * Set once we deliberately give up the control connection (`drain()`/`disconnect()`).
   * Distinct from `_controlWs === null`, which also covers "never connected": only after a
   * hand-back is it certain that no server terminal frame can still arrive.
   */
  private _controlGivenUp = false;
  /** serve()'s stop hook, so takeover can end the block the same way a signal does. */
  private _stopServe: ((why: string) => void) | null = null;
  // Set when the server hands the slot away (`agent.retired`). Same meaning as a 4409 close,
  // except the connection stays open so terminal events of in-flight calls still arrive.
  private _onRetired: (() => void) | null = null;
  // Whether calls can be answered right now. The file marker and /healthz read this same bit.
  private _ready = false;
  private _onTakenOver?: (info: { code: number; reason: string }) => void;
  /** 미디어 정리를 마친 통화가 서버 종료 프레임을 기다리는 자리. callId → resolve. */
  private _terminalWaiters = new Map<string, () => void>();
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
    this._onTakenOver = options.onTakenOver;

    // Configure tracing
    if (options.tracing) {
      setTracingConfig(options.tracing);
    }

    this._log = createAgentLogger(options.logger);
    // **Clear a stale readiness marker here.** Deferring it to connect() leaves the stretch in
    // between (heavy imports, model clients warming) as a window: a read-only-rootfs deploy
    // commonly mounts an emptyDir at /tmp, and that volume outlives a container restart. After
    // a SIGKILL the previous process's marker is still there, so the pod goes Ready *before it
    // has connected* and the calls that arrive in between die.
    clearStaleReadyMarker(this._log);

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

    // Deployment diagnostics — these change nothing, they only make the quiet failures loud.
    // The stale marker was already cleared in the constructor; this is idempotent and covers
    // callers that invoke connect() more than once.
    clearStaleReadyMarker(this._log);
    // A stale marker cleared at import time is reported here — back then no logger existed.
    const stale = takeStaleClearNotice();
    if (stale) {
      this._log.warn(
        `Cleared a stale readiness marker: ${stale} — a previous process left it behind. ` +
          'Left in place it marks the new process Ready before it has connected, and the ' +
          'calls that arrive in between die.',
      );
    }
    warnIfSignalsBlocked(this._log);

    // Reconnecting after a handover is not recovery — the slot is exclusive per number, so a
    // fresh control connection evicts the process that just took over, which reconnects and
    // evicts us back. `call()` funnels through here, so an outbound call placed during or
    // after a drain would otherwise reopen the connection the drain just gave up.
    if (this._takenOver) {
      throw new AgentError(
        `${this._fromNumber} is now served by another process — reconnecting would evict it. ` +
          'Start a new agent process instead of reconnecting this one.',
      );
    }

    if (!this._apiKey) {
      throw new AgentError('API key is required. Set CLAWOPS_API_KEY or pass apiKey option.');
    }
    if (!this._accountId) {
      throw new AgentError(
        'Account ID is required. Set CLAWOPS_ACCOUNT_ID or pass accountId option.',
      );
    }

    // Connect control WebSocket
    this._controlGivenUp = false;
    this._controlWs = new ControlWebSocket({
      baseUrl: this._baseUrl,
      apiKey: this._apiKey,
      accountId: this._accountId,
      number: this._fromNumber,
      onTerminalClose: (info) => this._handleTakenOver(info),
    });

    this._controlWs.setLogger(this._log);

    this._controlWs.on('call.incoming', (event) => this._handleIncoming(event));
    this._controlWs.on('call.ended', (event) => this._handleEnded(event));
    this._controlWs.on('call.outbound_ready', (event) => this._handleOutboundReady(event));
    this._controlWs.on('call.ringing', (event) => this._handleRinging(event));
    this._controlWs.on('call.failed', (event) => this._handleFailed(event));
    this._controlWs.on('agent.retired', (event) =>
      this._handleRetired(String(event.reason ?? '')),
    );
    this._controlWs.on('agent.active', () =>
      this._log.info('Server put this connection back in the slot (promoted)'),
    );

    try {
      await this._controlWs.connect();
      await this._controlWs.waitConnected();
      try {
        this._controlWs.send({ event: 'agent.hello', sdk: getSdkInfo() });
      } catch { /* best-effort */ }
      // This is the moment calls can be answered — only the SDK knows it, so the SDK marks it.
      // The customer's app used to have to create this file itself right here.
      this._ready = true;
      writeReadyMarker(this._log);
    } catch (err) {
      throw new AgentConnectionError(
        `Failed to connect to ClawOps: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this._log.info('ClawOpsAgent connected on %s', this._fromNumber);
  }

  /**
   * Connect and block until it is time to stop.
   *
   * Returns on SIGINT/SIGTERM, or when another process takes over this number — in every case
   * after `drain()` has let in-flight calls finish. A second signal skips the wait and cuts them.
   *
   * ⚠️ **The takeover notice does not always arrive.** It is sent when a connection is replaced
   * within the same gateway; if the new instance lands on a different one, the old instance is
   * never told (measured in production, 2026-09-09). It then stays up — taking no new calls —
   * until a stop signal, and drains there instead.
   *
   * Either way **calls always go to the newest instance**, because delivery is decided by the
   * shared registry rather than any one gateway's. So zero-downtime holds regardless. What does
   * not hold is "start the new one and the old one disappears" — a rolling deploy still has to
   * take the old instance down.
   *
   * **There is no deadline by default.** In-flight calls are waited out and the only thing that
   * ends them is the platform SIGKILL. The old default (110s) came from the ECS `stopTimeout`
   * ceiling and was applied to k8s too, which is why **29.8% of in-flight calls were being cut
   * by us** rather than finishing.
   *
   * Set the platform grace period (k8s `terminationGracePeriodSeconds`, ECS `stopTimeout`) to
   * cover your calls. Where that grace is capped — ECS tops out at 120s — pass an explicit
   * `shutdownDeadlineMs` slightly under it so the process cleans up on its own terms instead.
   * A finite deadline is **shared** between the handover wait and the drain, never added.
   *
   * ⚠️ Without a deadline there is still a way out: a second stop signal skips the handover and
   * a third cuts in-flight calls. SIGINT counts its first as the second, so two Ctrl-C's cut.
   *
   * @param options.drainTimeoutMs Passed through to `drain()`. Unbounded by default.
   */
  async serve(options?: {
    drainTimeoutMs?: number;
    handoverWaitMs?: number;
    shutdownDeadlineMs?: number;
    /** Open `/healthz` on this port — the only probe a distroless image can answer. */
    healthPort?: number;
  }): Promise<void> {
    let health: Awaited<ReturnType<typeof startHealthServer>> | null = null;
    if (options?.healthPort !== undefined) {
      // Opened **before** connect(): a slow start should still answer the probe (with 503).
      // A port that never opens fails the probe as a connection refusal instead.
      health = await startHealthServer(options.healthPort, () => this._ready, this._log);
    }
    try {
      await this._serveInner(options ?? {});
    } finally {
      if (health) await new Promise<void>((resolve) => health.close(() => resolve()));
    }
  }

  private async _serveInner(options: {
    drainTimeoutMs?: number;
    handoverWaitMs?: number;
    shutdownDeadlineMs?: number;
  }): Promise<void> {
    await this.connect();

    const handoverWaitMs = options.handoverWaitMs ?? DEFAULT_HANDOVER_WAIT_MS;
    const shutdownDeadlineMs = options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
    const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

    const stop = latch();
    // "Stop waiting for the handover" — the second signal, or SIGINT. Different from cutting:
    // the drain still protects calls already in progress.
    const skipHandover = latch();
    const cut = latch();
    const retired = latch();

    this._stopServe = () => stop.set();
    this._onRetired = () => retired.set();
    // A handover that landed before serve() started (replaced right after connect).
    if (this._takenOver) {
      retired.set();
      stop.set();
    }

    let signals = 0;
    const onSignal = (name: string): void => {
      // Signals raise the level one step at a time. A takeover starts the shutdown by itself and
      // the orchestrator's SIGTERM lands right after — counting that first signal as "don't
      // wait" would cut exactly the calls the drain exists to protect.
      //
      //   1st  begin shutdown (SIGTERM waits for the handover; SIGINT goes straight to draining)
      //   2nd  stop waiting for the handover → drain
      //   3rd  cut the calls still in progress
      signals += 1;
      if (signals === 1) {
        // Whether this line exists at all is the tell for the shell-entrypoint trap: a process
        // that never heard the signal has no such line. Post-mortems run off the log.
        this._log.info('%s received — beginning shutdown', name);
        // Ctrl-C on a laptop must not wait 20 seconds for a successor that will never come.
        if (name === 'SIGINT') skipHandover.set();
      } else if (!skipHandover.done) {
        this._log.warn('%s: second stop signal — no longer waiting for a handover', name);
        skipHandover.set();
      } else {
        this._log.warn('%s: repeated stop signal — ending calls in progress now', name);
        cut.set();
      }
      stop.set();
    };
    const onSigint = (): void => onSignal('SIGINT');
    const onSigterm = (): void => onSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    try {
      await stop.promise;
      const deadlineAt = Date.now() + shutdownDeadlineMs;

      // ── Phase 1: wait for the handover ──
      if (handoverWaitMs > 0 && !skipHandover.done && !retired.done && !cut.done) {
        // From here on, a disconnect for any reason must not lead to a reconnect: that would
        // evict whichever process has taken the slot, and that one never got a stop signal.
        this._controlWs?.enterLameDuck();
        const budget = Math.min(handoverWaitMs, Math.max(0, deadlineAt - Date.now()));
        this._log.info('Waiting for a successor — still holding the slot (up to %dms)', budget);
        await firstOf([retired.promise, skipHandover.promise, cut.promise], budget);
        this._log.info(
          retired.done
            ? 'Handover complete — new calls go to the successor'
            : 'No handover notice — releasing the slot and draining',
        );
      }

      // ── Phase 2: drain ──
      if (cut.done) {
        await this.disconnect();
        return;
      }

      // If the handover arrived, the server already took the slot — keep the connection so the
      // terminal events of in-flight calls (and their durations) still come back here. Without
      // a handover we have to release it ourselves so new calls go elsewhere.
      const releaseSlot = !retired.done;
      const budget = Math.max(0, Math.min(drainTimeoutMs, deadlineAt - Date.now()));
      const draining = this.drain({ timeoutMs: budget, releaseSlot }).catch((err) => {
        this._log.error({ err }, 'Drain failed');
      });
      // A further signal cuts: disconnect() clears the active sessions, so the drain loop sees
      // an empty set and returns on its next tick.
      const cutting = cut.promise.then(() => this.disconnect());
      await Promise.race([draining, cutting]);
      await draining;
    } finally {
      // Leaving the handlers attached past the drain would make SIGTERM a no-op for the rest of
      // the process's life — the default "terminate" disposition is suppressed while a listener
      // exists, and this closure has nothing left to do.
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      this._stopServe = null;
      this._onRetired = null;
    }
  }

  private _handleTakenOver(info: { code: number; reason: string }): void {
    this._takenOver = true;
    this._log.info(
      'Another process now serves %s (close %d) — handing over',
      this._fromNumber,
      info.code,
    );
    this._notReady();
    this._onTakenOver?.(info);
    // The connection is gone, but "the slot moved" is the same fact — mark it so serve() does
    // not try to release a slot that is no longer ours.
    this._onRetired?.();
    this._stopServe?.('taken over');
  }

  /**
   * The server handed the slot to another process (`agent.retired`) — **the connection is
   * still open.** It was left open so terminal events of calls already in progress come back
   * here, so this must not close it. The server closes it once we are idle.
   *
   * Arriving with no stop signal means this is not a deploy we know about — almost always two
   * instances running on the same number. Say so in the log.
   */
  private _handleRetired(reason: string): void {
    this._takenOver = true;
    // The slot is gone, so no new calls come here. Dropping the probe is what makes the
    // orchestrator take this instance out of rotation.
    this._notReady();
    this._log.info('Another process now serves %s (%s) — handing over', this._fromNumber, reason);
    if (!this._stopServe) {
      this._log.warn(
        'Handover with no stop signal — check that only one instance serves %s (replicas must be 1)',
        this._fromNumber,
      );
    }
    this._onTakenOver?.({ code: CLOSE_REPLACED, reason });
    this._onRetired?.();
    this._stopServe?.('retired');
  }

  /** No longer able to take calls — drop both readiness signals. Idempotent. */
  private _notReady(): void {
    this._ready = false;
    removeReadyMarker();
  }

  /** Whether another process has taken over this number's control connection. */
  get takenOver(): boolean {
    return this._takenOver;
  }

  /**
   * Stop accepting new calls, let the ones already in progress finish, then disconnect.
   *
   * This is what a rolling deploy needs. `disconnect()` cuts live calls mid-sentence, which is
   * correct when you mean "stop now" and wrong when you mean "hand over". The two are separated
   * because only the caller knows which one a SIGTERM meant.
   *
   * It works because control and media are different connections. Closing the control WebSocket
   * only gives up this number's delivery slot — the server stops sending us `call.incoming` and
   * routes new calls to whichever process holds the slot next. Calls already up keep streaming
   * over their own per-call media connections, which nothing here touches, and each one tears
   * itself down normally when the caller hangs up.
   *
   * Deploy shape this is built for: start the new instance, let it take the slot (the server
   * hands it over and tells us not to reconnect), then drain the old one. New calls go to the
   * new instance from the moment it connects; in-flight calls end on the old one. No gap.
   *
   * One thing is given up: `endedDuration` on `call_end`. That figure rides the control
   * connection we just closed, so calls finishing during a drain report a null duration.
   *
   * @param options.timeoutMs How long to wait for in-flight calls. **Unbounded by default** —
   *   calls are waited out and only the platform SIGKILL ends them. Pass a value and calls still
   *   running when it expires are ended the way `disconnect()` ends them; that only makes sense
   *   where the platform grace period is capped (ECS `stopTimeout` tops out at 120s) and you would
   *   rather clean up on your own terms than be killed mid-drain.
   * @returns How many calls ended on their own, and how many had to be cut short.
   */
  async drain(options?: {
    timeoutMs?: number;
    /**
     * Whether to give up the delivery slot ourselves.
     *
     * When the server has already sent the handover notice (`agent.retired`) the slot is gone
     * anyway, so pass **false** and keep the connection: that is how the terminal events of
     * in-flight calls — and their durations — still reach us. Only a shutdown without a
     * handover has to release the slot itself.
     */
    releaseSlot?: boolean;
  }): Promise<{ completed: number; forced: number }> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const releaseSlot = options?.releaseSlot ?? true;
    // Draining means no new calls. The handover may already have cleared this; it is idempotent.
    this._notReady();

    if (releaseSlot) {
      // Give up the delivery slot first. Every call that arrives after this goes elsewhere.
      this._controlGivenUp = true;
      if (this._controlWs) {
        this._controlWs.close();
        this._controlWs = null;
      }
      // No terminal frame can arrive on a closed control connection — release anyone waiting on
      // one now. Calls that finish *later* in the drain are covered by the `_controlGivenUp`
      // check in `_awaitServerTerminal`; without it they would each register a fresh waiter that
      // nothing can ever wake, and burn the full grace window for nothing.
      for (const wake of [...this._terminalWaiters.values()]) wake();
    } else {
      // The server already took the slot. Leaving the connection open is the whole point — it
      // is what makes `endedDuration` arrive for calls that finish during the drain. Before
      // this, drain() always closed first, so that duration was always missing.
      this._log.info('Slot already handed over — draining with the connection kept open');
    }

    const inFlight = this._activeSessions.size;
    if (inFlight === 0) {
      this._log.info('Drain: no calls in progress');
      await this.disconnect();
      return { completed: 0, forced: 0 };
    }

    this._log.info(
      'Drain started: waiting for %d call(s) to finish (%s)',
      inFlight,
      Number.isFinite(timeoutMs) ? `timeout ${timeoutMs}ms` : 'no timeout — until the platform grace period',
    );
    const started = Date.now();
    const deadline = started + timeoutMs;
    while (this._activeSessions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
    }

    const elapsed = Date.now() - started;
    const forced = this._activeSessions.size;
    if (forced > 0) {
      this._log.warn(
        `Drain timed out after ${elapsed}ms — cutting ${forced} call(s) still in progress. ` +
          'The platform grace period (terminationGracePeriodSeconds / stopTimeout) has to ' +
          `exceed the ${timeoutMs}ms drain timeout for these cuts to stop ` +
          '(leave the timeout unset and it is unbounded).',
      );
    } else {
      this._log.info('Drain complete in %dms: all %d call(s) finished', elapsed, inFlight);
    }

    await this.disconnect();
    return { completed: inFlight - forced, forced };
  }

  /** Disconnect from the platform. */
  async disconnect(): Promise<void> {
    this._notReady();
    this._controlGivenUp = true;
    if (this._controlWs) {
      this._controlWs.close();
      this._controlWs = null;
    }

    // 제어 연결이 닫힌 뒤엔 종료 프레임이 올 수 없다 — 기다리는 통화를 즉시 놓아주지 않으면
    // 종료 중인 통화마다 상한(2초)을 통째로 헛쓴다. ControlWebSocket.close() 가 대기 중인
    // 전환 resolver 를 정리하는 것과 같은 규율이다.
    for (const wake of [...this._terminalWaiters.values()]) wake();

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

  /**
   * 서버 종료 프레임을 짧게 기다린다. 미디어 정리 직후에만 부른다.
   *
   * 왜 기다리나: `call_end` 는 인바운드 사용자가 통화 결과를 받는 **유일한 통로**인데, 서버는
   * 미디어 WS 를 먼저 닫고 자원 정리를 마친 뒤에야 control 종료 프레임을 보낸다. 안 기다리면
   * 그 핸들러 안에서 `endedDuration` 은 영영 null 이다.
   *
   * 상한을 다 쓰는 경우는 제어 연결이 죽어 프레임이 아예 안 오는 때뿐이다 — 그 프레임은
   * 예전부터 늘 오던 것이고(이번에 바뀐 건 내용뿐), 정상 경로에서는 밀리초 안에 풀린다.
   */
  private async _awaitServerTerminal(session: CallSession): Promise<void> {
    if (session.endedDuration !== null) return;
    // 제어 연결을 이미 내놓았으면(drain/disconnect 이후) 종료 프레임은 영영 오지 않는다.
    // 기다려 봐야 통화마다 유예를 통째로 헛쓰고 drain 꼬리만 길어진다.
    if (this._controlGivenUp) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this._terminalWaiters.delete(session.callId);
        resolve();
      };
      const timer = setTimeout(() => {
        this._log.debug(
          '서버 종료 프레임이 %dms 안에 오지 않았다 — endedDuration 없이 진행: %s',
          TERMINAL_FRAME_GRACE_MS,
          session.callId,
        );
        done();
      }, TERMINAL_FRAME_GRACE_MS);
      this._terminalWaiters.set(session.callId, done);
    });
  }

  private _handleEnded(event: ControlEvent): void {
    const callId = event['callId'] as string;
    // 서버는 종료 사유를 status 로 싣는다(completed/no-answer/busy/rejected/canceled/
    // failed). 예전에는 이 값을 버려서 상대가 받지 않은 통화를 성사된 통화와 구분할 수
    // 없었다.
    const status = (event['status'] as string) || 'completed';
    // 서버가 확정한 통화 시간. 구 서버는 이 값을 안 보내거나 0 을 보내므로 그대로 둔다 —
    // 없는 값을 로컬 계산으로 지어내면 어느 쪽인지 구분할 수 없게 된다.
    const endedDuration = event['duration'];
    const session = this._activeSessions.get(callId);
    if (session) {
      this._log.info('Call ended (server): %s (status=%s)', callId, status);
      if (typeof endedDuration === 'number') session._setEndedDuration(endedDuration);
      if (status !== 'completed') {
        // 미연결 종료. call_start 가 없었으므로 call_end 도 발화되지 않는다 —
        // 이 이벤트가 발신 실패를 알 수 있는 유일한 통로다.
        this._log.info('Outbound call not connected: %s (%s)', callId, status);
        session._emit('call_failed', status);
      }
      session._markEnded(status);
      this._activeSessions.delete(callId);
    }
    // 미디어 정리를 마치고 이 프레임을 기다리는 통화가 있으면 깨운다(awaitServerTerminal).
    this._terminalWaiters.get(callId)?.();
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
  /**
   * 세션에 콜별 의존성(도구·내장도구·hold audio·recorder·logger)을 주입한다.
   *
   * prewarm 과 _startCallSession 양쪽에서 부른다. prewarm 은 세션이 LLM 에 보낼
   * tool 스키마를 그 시점에 확정하므로(OpenAI session.update / Gemini live connect
   * config), prewarm **전에** 최소 한 번은 도구가 들어가 있어야 한다.
   */
  private _injectSessionDeps(tools: ToolRegistry, recorder?: AudioRecorder | null): void {
    const sessionHandler = this._session;
    if (
      'setToolRegistry' in sessionHandler &&
      typeof sessionHandler.setToolRegistry === 'function'
    ) {
      sessionHandler.setToolRegistry(tools);
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
  }

  private _startPrewarm(callId: string): void {
    if (this._prewarmTasks.has(callId)) return;
    const sessionHandler = this._session;
    if (typeof sessionHandler.prewarm !== 'function') return;

    // MCP 도구는 통화 시작 시점(_startCallSession)에야 등록되는데, 연결 후 도구
    // 변경이 불가능한 세션(Gemini Live)은 prewarm 하면 MCP 도구를 영영 못 쓴다.
    // 그런 조합에서는 prewarm 을 건너뛰고 기존 start() 경로로 간다.
    if (
      this._mcpServers.length > 0 &&
      (sessionHandler as { toolsFrozenAfterPrewarm?: boolean }).toolsFrozenAfterPrewarm
    ) {
      this._log.info(
        { callId },
        'Skipping prewarm — 세션이 연결 후 도구 변경을 지원하지 않아 MCP 도구가 누락된다.',
      );
      return;
    }

    // prewarm 은 tool 스키마를 LLM 에 확정 전송한다. 여기서 주입하지 않으면
    // agent.tool() 로 등록한 도구가 통째로 빠진 채 세션이 시작된다 —
    // _startCallSession 의 주입은 answer 이후라 이미 늦다.
    this._injectSessionDeps(this._tools.fork());

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
      const reason = (event['reason'] as string) ?? 'failed';
      this._log.info('Outbound call failed: %s (%s)', callId, reason);
      session._emit('call_failed', reason);
      session._markEnded(reason);
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

        // `drain()` nulls the control connection while this call keeps running, so the
        // reference has to be re-read and checked per transfer — the non-null assertion used
        // to turn a transfer during a drain into a bare TypeError out of the user's tool.
        session._transferFn = (params) => {
          const controlWs = this._controlWs;
          if (!controlWs) {
            throw new AgentError(
              'transfer unavailable: the control connection is closed (draining, or this number was taken over)',
            );
          }
          return controlWs.requestTransfer(session.callId, params);
        };

        // Media WS mark/flush 를 세션에 노출 — LiveKit ClawOpsAudioOutput 이 재생 완료
        // (mark echo) 판정과 barge-in 절단 위치 계산에 쓴다. native 세션은 읽지 않는다.
        session._sendMark = (name: string) => mediaWs.sendMark(name);
        session._waitForMark = (name: string, timeoutMs: number) => mediaWs.waitForMark(name, timeoutMs);
        session._flushTransport = () => mediaWs.flush();

        const sessionHandler = this._session;

        // Inject tools and recorder into session if supported
        this._injectSessionDeps(sessionTools, recorder);

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

          // 서버가 확정한 통화 시간을 call_end 핸들러가 읽을 수 있게 잠깐 기다린다.
          // 서버는 미디어 WS 를 먼저 닫고 자원 정리 뒤에 control 종료 프레임을 보내므로,
          // 안 기다리면 endedDuration 은 인바운드 사용자에게 **영영 null** 이다 —
          // call_end 가 그들의 유일한 통로다.
          await this._awaitServerTerminal(session);

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
