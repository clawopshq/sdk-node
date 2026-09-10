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
  /**
   * Called when the server closes the connection with a code that means "do not reconnect"
   * (the number was handed to another process, or is no longer owned by this account).
   * Reconnection has already been abandoned by the time this fires.
   */
  onTerminalClose?: (info: { code: number; reason: string }) => void;
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
/** Server sends ping every 30s; if no ping arrives within this window, assume dead. */
const PING_TIMEOUT = 60000;

/** Another process took over this number's control connection (zero-downtime deploy). */
export const CLOSE_REPLACED = 4409;
/** The number is no longer owned by this account (released or reassigned). */
export const CLOSE_OWNERSHIP_LOST = 4403;

/**
 * Close codes after which reconnecting is wrong, not merely useless.
 *
 * A control connection is exclusive per phone number: one number, one owner. So when the
 * server hands that slot to a newer process and we reconnect anyway, we do not recover our
 * own connection — we evict the process that just took over, which then reconnects and
 * evicts us. During a rolling deploy the two instances trade the slot for as long as they
 * overlap, and the server's reconnect throttle eventually quarantines the number for
 * minutes. Reconnecting turns a graceful handover into an outage.
 *
 * Every other close code (1001 gateway draining, 1006 network loss, …) still reconnects:
 * there the slot is genuinely free and we are the one meant to hold it.
 */
const NON_RETRYABLE_CLOSE_CODES = new Set<number>([CLOSE_REPLACED, CLOSE_OWNERSHIP_LOST]);

/**
 * Build the full control WebSocket URL from options.
 * Matches Python SDK: /v1/accounts/{account_id}/agent/listen?number={number}
 */
export function buildControlWsUrl(options: ControlWsOptions, role?: string): string {
  const scheme = options.baseUrl.startsWith('https') ? 'wss' : 'ws';
  const host = options.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let url = `${scheme}://${host}/v1/accounts/${encodeURIComponent(options.accountId)}/agent/listen`;
  if (options.number) {
    url += `?number=${encodeURIComponent(options.number)}`;
  }
  // role=retiring — "I am already stepping down; do not give me the slot."
  //
  // Not reconnecting at all is the first defence, but a path may remain that reconnects anyway
  // (a lower-level retry). Without this flag such a reconnect evicts a successor that never
  // received SIGTERM — the very ping-pong the lame duck exists to prevent.
  if (role && options.number) {
    url += `&role=${encodeURIComponent(role)}`;
  }
  return url;
}

export class ControlWebSocket {
  private _url: string;
  private _ws: WsType | null = null;
  private _handlers: Map<string, ControlEventHandler[]> = new Map();
  private _transferResolvers = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: Error) => void;
  }>();
  private _reconnectDelay = INITIAL_RECONNECT_DELAY;
  private _closed = false;
  private _connectedResolve: (() => void) | null = null;
  private _connectedPromise: Promise<void>;
  private _log: Logger = NOOP_LOGGER;
  private _pingTimer: ReturnType<typeof setTimeout> | null = null;
  // Lame duck: this process is stepping down. It must NOT reconnect for any reason — a
  // reconnect evicts whichever process has taken the slot in the meantime, and that one never
  // received a stop signal.
  private _lameDuck = false;

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  constructor(private readonly _options: ControlWsOptions) {
    this._url = buildControlWsUrl(_options);
    this._connectedPromise = new Promise<void>((resolve) => {
      this._connectedResolve = resolve;
    });
  }

  /** Stop reconnecting for good — this process is stepping down. Not reversible. */
  enterLameDuck(): void {
    if (this._lameDuck) return;
    this._lameDuck = true;
    // Second line of defence: if some path does reconnect, at least do not take the slot.
    this._url = buildControlWsUrl(this._options, 'retiring');
  }

  get lameDuck(): boolean {
    return this._lameDuck;
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

  /** Request a call transfer and wait for the result. */
  async requestTransfer(callId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = ((params.timeout as number) || 30) + 10;
      const timer = setTimeout(() => {
        this._transferResolvers.delete(callId);
        reject(new Error('transfer timeout'));
      }, timeout * 1000);

      this._transferResolvers.set(callId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (reason) => { clearTimeout(timer); reject(reason); },
      });

      this.send({
        event: 'call.transfer',
        callId,
        transfer: params,
      });
    });
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
    this._clearPingTimer();
    for (const [, resolver] of this._transferResolvers) {
      resolver.reject(new Error('connection closed'));
    }
    this._transferResolvers.clear();
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
      this._resetPingTimer();
      if (this._connectedResolve) {
        this._connectedResolve();
        this._connectedResolve = null;
      }
      this._log.info('Control WS connected: %s', this._url);
    });

    ws.on('ping', () => {
      this._resetPingTimer();
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as ControlEvent;
        this._dispatchEvent(msg);
      } catch {
        this._log.warn('Control WS parse error');
      }
    });

    ws.on('close', (code: number, reason: Buffer | string) => {
      this._clearPingTimer();
      if (this._closed) return;

      if (NON_RETRYABLE_CLOSE_CODES.has(code)) {
        const text = reason?.toString() || '';
        // Stop for good. _closed also stops any reconnect already in flight.
        this._closed = true;
        this._log.info(
          'Control WS closed by server (%d %s) — not reconnecting: this number is now served elsewhere',
          code,
          text,
        );
        this._options.onTerminalClose?.({ code, reason: text });
        return;
      }

      this._scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      this._log.warn('Control WS error: %s', err.message);
    });
  }

  private _dispatchEvent(event: ControlEvent): void {
    // The slot was handed to another process, but **the connection is still open** — the server
    // kept it so the terminal events of calls already in progress come back here. Do not close.
    if (event.event === 'agent.retired') {
      this._lameDuck = true;
    }

    // Resolve pending transfer promises on terminal transfer events
    if (['call.transfer.completed', 'call.transfer.failed'].includes(event.event)) {
      const callId = event.callId as string;
      const resolver = this._transferResolvers.get(callId);
      if (resolver) {
        this._transferResolvers.delete(callId);
        resolver.resolve((event.transfer as Record<string, unknown>) || {});
      }
    }

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

  private _resetPingTimer(): void {
    this._clearPingTimer();
    this._pingTimer = setTimeout(() => {
      this._log.warn('Control WS ping timeout, closing connection');
      if (this._ws) {
        this._ws.terminate();
      }
    }, PING_TIMEOUT);
  }

  private _clearPingTimer(): void {
    if (this._pingTimer) {
      clearTimeout(this._pingTimer);
      this._pingTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this._lameDuck) {
      this._log.info('Control WS closed — stepping down, not reconnecting');
      this._closed = true;
      return;
    }
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
