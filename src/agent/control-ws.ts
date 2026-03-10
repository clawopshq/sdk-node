/**
 * Control WebSocket for agent signaling (call.incoming, call.ended, etc.).
 */

import type { WebSocket as WsType } from 'ws';

export interface ControlWsOptions {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  /** Override control WS path. Default: /v1/agent/control */
  path?: string;
}

export interface ControlEventData {
  call_id: string;
  from_number?: string;
  to_number?: string;
  account_id?: string;
  direction?: 'inbound' | 'outbound';
  media_ws_url?: string;
  metadata?: Record<string, unknown>;
  reason?: string;
}

export interface ControlEvent {
  event: string;
  data: ControlEventData;
}

type ControlEventHandler = (event: ControlEvent) => void | Promise<void>;

const DEFAULT_PATH = '/v1/agent/control';
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

/**
 * Build the full control WebSocket URL from options.
 */
export function buildControlWsUrl(options: ControlWsOptions): string {
  const base = options.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  const path = options.path ?? DEFAULT_PATH;
  return `${base}${path}?api_key=${encodeURIComponent(options.apiKey)}&agent_id=${encodeURIComponent(options.agentId)}`;
}

export class ControlWebSocket {
  private _url: string;
  private _ws: WsType | null = null;
  private _handlers: Map<string, ControlEventHandler[]> = new Map();
  private _reconnectDelay = INITIAL_RECONNECT_DELAY;
  private _closed = false;
  private _connectedResolve: (() => void) | null = null;
  private _connectedPromise: Promise<void>;

  constructor(private readonly _options: ControlWsOptions) {
    this._url = buildControlWsUrl(_options);
    this._connectedPromise = new Promise<void>((resolve) => {
      this._connectedResolve = resolve;
    });
  }

  /** Register an event handler for a specific event type. */
  on(event: string, handler: ControlEventHandler): void {
    let list = this._handlers.get(event);
    if (!list) {
      list = [];
      this._handlers.set(event, list);
    }
    list.push(handler);
  }

  /** Connect to the control WebSocket. */
  async connect(): Promise<void> {
    this._closed = false;
    await this._doConnect();
  }

  /** Wait until the WebSocket is connected. */
  async waitConnected(): Promise<void> {
    return this._connectedPromise;
  }

  /** Send a JSON message over the control WebSocket. */
  send(message: Record<string, unknown>): void {
    if (this._ws && this._ws.readyState === 1 /* OPEN */) {
      this._ws.send(JSON.stringify(message));
    }
  }

  /** Close the WebSocket and stop reconnecting. */
  close(): void {
    this._closed = true;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  private async _doConnect(): Promise<void> {
    const { WebSocket } = await import('ws');

    const ws = new WebSocket(this._url);
    this._ws = ws;

    ws.on('open', () => {
      this._reconnectDelay = INITIAL_RECONNECT_DELAY;
      if (this._connectedResolve) {
        this._connectedResolve();
        this._connectedResolve = null;
      }
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as ControlEvent;
        this._dispatchEvent(msg);
      } catch {
        console.error('[ControlWebSocket] Failed to parse message');
      }
    });

    ws.on('close', () => {
      if (!this._closed) {
        this._scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      console.error('[ControlWebSocket] Error:', err.message);
    });
  }

  private _dispatchEvent(event: ControlEvent): void {
    const handlers = this._handlers.get(event.event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => {
              console.error(`[ControlWebSocket] Error in handler for ${event.event}:`, err);
            });
          }
        } catch (err) {
          console.error(`[ControlWebSocket] Error in handler for ${event.event}:`, err);
        }
      }
    }
  }

  private _scheduleReconnect(): void {
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_DELAY);

    setTimeout(() => {
      if (!this._closed) {
        this._doConnect().catch((err) => {
          console.error('[ControlWebSocket] Reconnect failed:', err);
          this._scheduleReconnect();
        });
      }
    }, delay);
  }
}
