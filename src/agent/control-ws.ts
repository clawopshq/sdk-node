/**
 * Control WebSocket for agent signaling (call.incoming, call.ended, etc.).
 */

import type { WebSocket as WsType } from 'ws';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from './logger.js';

export interface ControlWsOptions {
  baseUrl: string;
  apiKey: string;
  accountId: string;
  /** Phone number to register on. */
  number?: string;
}

/**
 * Control event is a flat JSON object with an 'event' field.
 * Example: { "event": "call.incoming", "callId": "xxx", "from": "070...", "mediaUrl": "wss://..." }
 */
export interface ControlEvent {
  event: string;
  [key: string]: unknown;
}

type ControlEventHandler = (event: ControlEvent) => void | Promise<void>;

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

/**
 * Build the full control WebSocket URL from options.
 * Matches Python SDK: /v1/accounts/{account_id}/agent/listen?number={number}
 */
export function buildControlWsUrl(options: ControlWsOptions): string {
  const scheme = options.baseUrl.startsWith('https') ? 'wss' : 'ws';
  const host = options.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let url = `${scheme}://${host}/v1/accounts/${encodeURIComponent(options.accountId)}/agent/listen`;
  if (options.number) {
    url += `?number=${encodeURIComponent(options.number)}`;
  }
  return url;
}

export class ControlWebSocket {
  private _url: string;
  private _ws: WsType | null = null;
  private _handlers: Map<string, ControlEventHandler[]> = new Map();
  private _reconnectDelay = INITIAL_RECONNECT_DELAY;
  private _closed = false;
  private _connectedResolve: (() => void) | null = null;
  private _connectedPromise: Promise<void>;
  private _log: Logger = NOOP_LOGGER;

  setLogger(logger: Logger): void {
    this._log = logger;
  }

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

    const ws = new WebSocket(this._url, {
      followRedirects: true,
      headers: {
        Authorization: `Bearer ${this._options.apiKey}`,
      },
    });
    this._ws = ws;

    ws.on('open', () => {
      this._reconnectDelay = INITIAL_RECONNECT_DELAY;
      if (this._connectedResolve) {
        this._connectedResolve();
        this._connectedResolve = null;
      }
      this._log.info('Control WS connected: %s', this._url);
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as ControlEvent;
        this._dispatchEvent(msg);
      } catch {
        this._log.warn('Control WS parse error');
      }
    });

    ws.on('close', () => {
      if (!this._closed) {
        this._scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      this._log.warn('Control WS error: %s', err.message);
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
              this._log.error({ err }, 'Control WS handler error: %s', event.event);
            });
          }
        } catch (err) {
          this._log.error({ err }, 'Control WS handler error: %s', event.event);
        }
      }
    }
  }

  private _scheduleReconnect(): void {
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_DELAY);
    this._log.info('Control WS reconnecting in %ds...', delay / 1000);

    setTimeout(() => {
      if (!this._closed) {
        this._doConnect().catch((err) => {
          this._log.warn({ err }, 'Control WS reconnect failed');
          this._scheduleReconnect();
        });
      }
    }, delay);
  }
}
