/**
 * ClawOpsAgent - main agent class for handling voice calls.
 */

import { DEFAULT_BASE_URL } from '../constants.js';
import { AgentConnectionError, AgentError } from '../error.js';
import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from './audio.js';
import { ControlWebSocket } from './control-ws.js';
import type { ControlEvent } from './control-ws.js';
import { MCPClient } from './mcp/client.js';
import type { MCPServerStdio } from './mcp/stdio.js';
import type { MCPServerHTTP } from './mcp/http.js';
import { MediaWebSocket } from './media-ws.js';
import { AudioRecorder } from './recorder.js';
import { CallSession } from './session.js';
import type { CallDirection } from './session.js';
import { ToolRegistry } from './tool.js';
import type { FunctionTool } from './tool.js';
import type { Session } from './pipeline/base.js';
import { setTracingConfig } from './tracing/config.js';
import type { TracingConfig } from './tracing/config.js';
import { withSpan } from './tracing/spans.js';
import { ATTR_CALL_ID, ATTR_CALL_DIRECTION, ATTR_AGENT_ID } from './tracing/attributes.js';

export type AgentEventType =
  | 'call.incoming'
  | 'call.ended'
  | 'call.outbound_ready'
  | 'call.ringing'
  | 'call.failed';

type AgentEventHandler = (session: CallSession) => void | Promise<void>;

export interface ClawOpsAgentOptions {
  /** ClawOps API key. Falls back to CLAWOPS_API_KEY env var. */
  apiKey?: string;
  /** Agent ID. Falls back to CLAWOPS_AGENT_ID env var. */
  agentId?: string;
  /** API base URL. */
  baseUrl?: string;
  /** Session factory: returns the session handler for each call. */
  session?: Session | (() => Session);
  /** Recording output directory. If set, calls are recorded. */
  recordingDir?: string;
  /** MCP server configurations. */
  mcpServers?: Record<string, MCPServerStdio | MCPServerHTTP>;
  /** Tracing configuration. */
  tracing?: TracingConfig;
}

export class ClawOpsAgent {
  private _apiKey: string;
  private _agentId: string;
  private _baseUrl: string;
  private _sessionFactory: (() => Session) | null = null;
  private _tools: ToolRegistry = new ToolRegistry();
  private _handlers: Map<AgentEventType, AgentEventHandler[]> = new Map();
  private _controlWs: ControlWebSocket | null = null;
  private _mcpClient: MCPClient | null = null;
  private _recordingDir: string | null;
  private _activeSessions: Map<string, CallSession> = new Map();

  constructor(options: ClawOpsAgentOptions = {}) {
    this._apiKey = options.apiKey ?? process.env['CLAWOPS_API_KEY'] ?? '';
    this._agentId = options.agentId ?? process.env['CLAWOPS_AGENT_ID'] ?? '';
    this._baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this._recordingDir = options.recordingDir ?? null;

    if (options.session) {
      if (typeof options.session === 'function') {
        this._sessionFactory = options.session as () => Session;
      } else {
        const sessionInstance = options.session;
        this._sessionFactory = () => sessionInstance;
      }
    }

    // Configure MCP
    if (options.mcpServers) {
      this._mcpClient = new MCPClient();
      for (const [name, config] of Object.entries(options.mcpServers)) {
        this._mcpClient.addServer(name, config);
      }
    }

    // Configure tracing
    if (options.tracing) {
      setTracingConfig(options.tracing);
    }
  }

  /** Register a function tool. */
  tool(tool: FunctionTool): this {
    this._tools.register(tool);
    return this;
  }

  /** Register an event handler. */
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
    if (!this._agentId) {
      throw new AgentError('Agent ID is required. Set CLAWOPS_AGENT_ID or pass agentId option.');
    }

    // Connect MCP and register tools
    if (this._mcpClient) {
      try {
        const mcpTools = await this._mcpClient.connect();
        this._tools.registerMcpTools(mcpTools);
      } catch (err) {
        console.error('[ClawOpsAgent] MCP connection error:', err);
      }
    }

    // Connect control WebSocket
    this._controlWs = new ControlWebSocket({
      baseUrl: this._baseUrl,
      apiKey: this._apiKey,
      agentId: this._agentId,
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
    // Close control WebSocket
    if (this._controlWs) {
      this._controlWs.close();
      this._controlWs = null;
    }

    // End active sessions
    for (const session of this._activeSessions.values()) {
      session._markEnded();
    }
    this._activeSessions.clear();

    // Disconnect MCP
    if (this._mcpClient) {
      await this._mcpClient.disconnect();
      this._tools.clearMcpTools();
    }
  }

  /**
   * Initiate an outbound call.
   */
  call(options: {
    to: string;
    from: string;
    metadata?: Record<string, unknown>;
  }): void {
    if (!this._controlWs) {
      throw new AgentError('Agent is not connected. Call connect() first.');
    }

    this._controlWs.send({
      action: 'call.create',
      data: {
        to_number: options.to,
        from_number: options.from,
        metadata: options.metadata,
      },
    });
  }

  private _handleIncoming(event: ControlEvent): void {
    const data = event.data;
    const session = new CallSession({
      callId: data.call_id,
      fromNumber: data.from_number ?? '',
      toNumber: data.to_number ?? '',
      accountId: data.account_id ?? '',
      direction: (data.direction as CallDirection) ?? 'inbound',
      metadata: data.metadata,
    });

    this._activeSessions.set(data.call_id, session);
    this._emitEvent('call.incoming', session);

    // Start the call session handler
    if (data.media_ws_url) {
      this._startCallSession(session, data.media_ws_url).catch((err) => {
        console.error(`[ClawOpsAgent] Error in call session ${data.call_id}:`, err);
      });
    }
  }

  private _handleEnded(event: ControlEvent): void {
    const session = this._activeSessions.get(event.data.call_id);
    if (session) {
      session._markEnded();
      this._activeSessions.delete(event.data.call_id);
      this._emitEvent('call.ended', session);
    }
  }

  private _handleOutboundReady(event: ControlEvent): void {
    const data = event.data;
    const session = new CallSession({
      callId: data.call_id,
      fromNumber: data.from_number ?? '',
      toNumber: data.to_number ?? '',
      accountId: data.account_id ?? '',
      direction: 'outbound',
      metadata: data.metadata,
    });

    this._activeSessions.set(data.call_id, session);
    this._emitEvent('call.outbound_ready', session);

    if (data.media_ws_url) {
      this._startCallSession(session, data.media_ws_url).catch((err) => {
        console.error(`[ClawOpsAgent] Error in call session ${data.call_id}:`, err);
      });
    }
  }

  private _handleRinging(event: ControlEvent): void {
    const session = this._activeSessions.get(event.data.call_id);
    if (session) {
      this._emitEvent('call.ringing', session);
    }
  }

  private _handleFailed(event: ControlEvent): void {
    const session = this._activeSessions.get(event.data.call_id);
    if (session) {
      session._markEnded();
      this._activeSessions.delete(event.data.call_id);
      this._emitEvent('call.failed', session);
    }
  }

  private async _startCallSession(session: CallSession, mediaWsUrl: string): Promise<void> {
    await withSpan(
      'clawops.call_session',
      {
        [ATTR_CALL_ID]: session.callId,
        [ATTR_CALL_DIRECTION]: session.direction,
        [ATTR_AGENT_ID]: this._agentId,
      },
      async () => {
        // Fork tools for this session
        const sessionTools = this._tools.fork();

        // Set up recorder if configured
        let recorder: AudioRecorder | null = null;
        if (this._recordingDir) {
          recorder = new AudioRecorder({ outputDir: this._recordingDir });
          recorder.start(session.callId);
        }

        // Connect media WebSocket
        const mediaWs = new MediaWebSocket();

        // Bind transport functions to session
        session._bindTransport(
          (audio: Buffer) => {
            // Convert PCM16 to ulaw for telephony
            const ulaw = pcm16ToUlaw(audio);
            mediaWs.sendAudio(ulaw.toString('base64'));
            if (recorder) {
              recorder.writeRawOutbound(audio);
            }
          },
          () => {
            mediaWs.sendClear();
          },
          () => {
            mediaWs.close();
          },
        );

        // Get or create session handler
        const sessionHandler = this._sessionFactory ? this._sessionFactory() : null;

        // Handle inbound audio
        mediaWs.onAudio((ulawAudio: Buffer) => {
          // Convert ulaw to PCM16
          const pcm = ulawToPcm16(ulawAudio);
          if (recorder) {
            recorder.writeInbound(pcm);
          }
          if (sessionHandler) {
            // Resample from 8kHz to 16kHz for most STT/realtime APIs
            const resampled = resamplePcm16(pcm, 8000, 16000);
            sessionHandler.feedAudio(resampled);
          }
        });

        mediaWs.onClose(() => {
          if (recorder) {
            recorder.stop();
          }
          session._markEnded();
        });

        try {
          await mediaWs.connect(mediaWsUrl);

          // Start the session handler
          if (sessionHandler) {
            await sessionHandler.start(session, sessionTools);
          }

          // Wait for the call to end
          await session.wait();

          // Stop the session handler
          if (sessionHandler) {
            await sessionHandler.stop();
          }
        } catch (err) {
          console.error(`[ClawOpsAgent] Call session error:`, err);
        } finally {
          mediaWs.close();
          if (recorder) {
            recorder.stop();
          }
        }
      },
    );
  }

  private _emitEvent(event: AgentEventType, session: CallSession): void {
    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(session);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => {
              console.error(`[ClawOpsAgent] Error in ${event} handler:`, err);
            });
          }
        } catch (err) {
          console.error(`[ClawOpsAgent] Error in ${event} handler:`, err);
        }
      }
    }
  }
}
