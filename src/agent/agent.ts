/**
 * ClawOpsAgent - main agent class for handling voice calls.
 */

import { DEFAULT_BASE_URL } from '../constants.js';
import { AgentConnectionError, AgentError } from '../error.js';
import { ulawToPcm16 } from './audio.js';
import { ControlWebSocket } from './control-ws.js';
import type { ControlEvent } from './control-ws.js';
import { MCPClient } from './mcp/client.js';
import type { MCPServerStdio, MCPServerHTTP } from './mcp/index.js';
import { MediaWebSocket } from './media-ws.js';
import { AudioRecorder } from './recorder.js';
import { CallSession } from './session.js';
import { ToolRegistry } from './tool.js';
import type { FunctionTool } from './tool.js';
import type { Session } from './pipeline/base.js';
import { setTracingConfig } from './tracing/config.js';
import type { TracingConfig } from './tracing/config.js';
import { withSpan } from './tracing/spans.js';
import { ATTR_CALL_ID, ATTR_CALL_DIRECTION, ATTR_AGENT_ID } from './tracing/attributes.js';

export type AgentEventType =
  | 'call_start'
  | 'call_end'
  | 'call_failed'
  | 'transcript';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentEventHandler = (...args: any[]) => void | Promise<void>;

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
  /** Enable DTMF tool registration on session handlers. Default: true */
  dtmfTools?: boolean;
  /** Debounce time (ms) for passive DTMF accumulation. Default: 500 */
  passiveDtmfDebounceMs?: number;
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
  private _dtmfTools: boolean;
  private _passiveDtmfDebounceMs: number;
  private _passiveDtmfBuffer: string[] = [];
  private _passiveDtmfTimer: ReturnType<typeof setTimeout> | null = null;
  private _passiveDtmfCallId: string | null = null;
  private _callSessions = new Map<string, Session>();

  constructor(options: ClawOpsAgentOptions) {
    this._apiKey = options.apiKey ?? process.env['CLAWOPS_API_KEY'] ?? '';
    this._accountId = options.accountId ?? process.env['CLAWOPS_ACCOUNT_ID'] ?? '';
    this._baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this._fromNumber = options.from;
    this._session = options.session;
    this._recording = options.recording ?? false;
    this._recordingPath = options.recordingPath ?? './recordings';
    this._mcpServers = options.mcpServers ?? [];
    this._dtmfTools = options.dtmfTools ?? true;
    this._passiveDtmfDebounceMs = options.passiveDtmfDebounceMs ?? 500;

    // Configure tracing
    if (options.tracing) {
      setTracingConfig(options.tracing);
    }
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
        throw new AgentError('tool(name, description, parameters, handler) requires all arguments.');
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
    if (!this._apiKey) {
      throw new AgentError('API key is required. Set CLAWOPS_API_KEY or pass apiKey option.');
    }
    if (!this._accountId) {
      throw new AgentError('Account ID is required. Set CLAWOPS_ACCOUNT_ID or pass accountId option.');
    }

    // Connect control WebSocket
    this._controlWs = new ControlWebSocket({
      baseUrl: this._baseUrl,
      apiKey: this._apiKey,
      accountId: this._accountId,
      number: this._fromNumber,
    });

    this._controlWs.on('call.incoming', (event) => this._handleIncoming(event));
    this._controlWs.on('call.ended', (event) => this._handleEnded(event));
    this._controlWs.on('call.outbound_ready', (event) => this._handleOutboundReady(event));
    this._controlWs.on('call.ringing', (event) => this._handleRinging(event));
    this._controlWs.on('call.failed', (event) => this._handleFailed(event));

    try {
      await this._controlWs.connect();
      await this._controlWs.waitConnected();
    } catch (err) {
      throw new AgentConnectionError(
        `Failed to connect to ClawOps: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    console.log(`[ClawOpsAgent] Connected on ${this._fromNumber}`);
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
    console.log('[ClawOpsAgent] Disconnected');
  }

  /**
   * Initiate an outbound call.
   * Matches Python SDK: agent.call(to, { timeout })
   */
  async call(to: string, options?: { timeout?: number }): Promise<CallSession> {
    await this.connect();

    const url = `${this._baseUrl}/v1/accounts/${this._accountId}/calls`;
    const body = { To: to, From: this._fromNumber, Timeout: options?.timeout ?? 60 };
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

    this._activeSessions.set(callSession.callId, callSession);
    console.log(`[ClawOpsAgent] Outbound call initiated: ${this._fromNumber} -> ${to} (${callSession.callId})`);
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

    this._activeSessions.set(callId, session);

    // Accept the call
    if (this._controlWs) {
      this._controlWs.send({ event: 'call.accept', callId });
    }

    if (mediaUrl) {
      this._startCallSession(session, mediaUrl).catch((err) => {
        console.error(`[ClawOpsAgent] Error in call session ${callId}:`, err);
      });
    }
  }

  private _handleEnded(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const session = this._activeSessions.get(callId);
    if (session) {
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

      // Register all agent-level event handlers on the session
      for (const [evt, handlers] of this._handlers) {
        for (const handler of handlers) {
          session.on(evt, handler);
        }
      }

      this._activeSessions.set(callId, session);
    }

    if (mediaUrl) {
      this._startCallSession(session, mediaUrl).catch((err) => {
        console.error(`[ClawOpsAgent] Error in call session ${callId}:`, err);
      });
    }
  }

  private _handleRinging(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const session = this._activeSessions.get(callId);
    if (session) {
      console.log(`[ClawOpsAgent] Outbound call ringing: ${callId}`);
    }
  }

  private _handleFailed(event: ControlEvent): void {
    const callId = event['callId'] as string;
    const session = this._activeSessions.get(callId);
    if (session) {
      session._emit('call_failed', (event['reason'] as string) ?? 'failed');
      session._markEnded();
      this._activeSessions.delete(callId);
    }
  }

  private _onDtmfEvent(callSession: CallSession, digit: string): void {
    callSession._emit('dtmf', digit);

    if ((callSession as any)._dtmfCollectorActive) {
      callSession._routeDtmf(digit);
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
          console.error('[ClawOpsAgent] feedDtmf error:', err);
        });
      }
    }, this._passiveDtmfDebounceMs);
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
            client.addServer('mcp', serverConfig);
            try {
              const tools = await client.connect();
              sessionTools.registerMcpTools(tools);
              mcpClients.push(client);
            } catch (err) {
              console.error('[ClawOpsAgent] MCP connection error:', err);
            }
          }
        }

        // Set up recorder if configured
        let recorder: AudioRecorder | null = null;
        if (this._recording) {
          recorder = new AudioRecorder(this._recordingPath, session.callId);
          recorder.start();
        }

        // Connect media WebSocket
        const mediaWs = new MediaWebSocket();

        // Bind transport functions to session — sessions send ulaw bytes directly
        session._bindTransport(
          (audio: Buffer) => {
            mediaWs.sendAudio(audio.toString('base64'));
          },
          () => {
            mediaWs.sendClear();
          },
          () => {
            mediaWs.close();
          },
          async (digit: string) => { mediaWs.sendDtmf(digit); },
          () => mediaWs.isConnected,
        );

        const sessionHandler = this._session;

        // Inject tools and recorder into session if supported
        if ('setToolRegistry' in sessionHandler && typeof sessionHandler.setToolRegistry === 'function') {
          sessionHandler.setToolRegistry(sessionTools);
        }
        if (recorder && 'setRecorder' in sessionHandler && typeof sessionHandler.setRecorder === 'function') {
          sessionHandler.setRecorder(recorder);
        }
        if ('setDtmfTools' in sessionHandler && typeof sessionHandler.setDtmfTools === 'function') {
          (sessionHandler as any).setDtmfTools(this._dtmfTools);
        }

        // Save session handler for DTMF routing
        this._callSessions.set(session.callId, sessionHandler);

        // Handle inbound audio — feed raw ulaw to session (each session converts as needed)
        mediaWs.onAudio((ulawAudio: Buffer, _timestamp: number) => {
          if (sessionHandler) {
            sessionHandler.feedAudio(ulawAudio);
          }
          if (recorder) {
            recorder.writeInbound(ulawToPcm16(ulawAudio));
          }
        });

        // Handle inbound DTMF
        mediaWs.onDtmf((digit: string) => {
          this._onDtmfEvent(session, digit);
        });

        mediaWs.onClose(() => {
          if (recorder) {
            recorder.stop();
          }
          session._markEnded();
        });

        // Emit call_start
        session._emit('call_start');

        try {
          await mediaWs.connect(mediaWsUrl, this._apiKey);

          // Start the session handler
          await sessionHandler.start(session, sessionTools);

          // Wait for the call to end
          await session.wait();

          // Stop the session handler
          await sessionHandler.stop();
        } catch (err) {
          console.error(`[ClawOpsAgent] Call session error:`, err);
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
