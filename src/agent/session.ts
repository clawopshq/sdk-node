/**
 * CallSession represents an active phone call and provides methods to
 * send audio, hang up, and listen for lifecycle events.
 */

import type { Logger } from 'pino';
import { NOOP_LOGGER } from './logger.js';
import { type CallMetrics, createCallMetrics, addMetricError } from './telemetry.js';

export type CallDirection = 'inbound' | 'outbound';
export type CallStatus = 'ringing' | 'active' | 'ended';

/**
 * Session event handler: receives (call, ...args) like the Python SDK.
 * For example, 'transcript' events pass (call, role, text).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionEventHandler = (...args: any[]) => void | Promise<void>;

export interface SendAudioFn {
  (audio: Buffer): void;
}

export interface ClearAudioFn {
  (): void;
}

export interface HangupFn {
  (): void | Promise<void>;
}

export interface SendDtmfFn {
  (digit: string): Promise<void>;
}

export class CallSession {
  readonly callId: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly accountId: string;
  readonly direction: CallDirection;
  readonly startTime: Date;
  readonly metadata: Record<string, unknown>;

  private _status: CallStatus;
  private _sendAudioFn: SendAudioFn | null = null;
  private _clearAudioFn: ClearAudioFn | null = null;
  private _hangupFn: HangupFn | null = null;
  /** @internal */ _sendDtmfFn: SendDtmfFn | null = null;
  /** @internal */ _isTransportConnected: (() => boolean) | null = null;
  private _dtmfCollectorActive = false;
  private _dtmfResolvers: ((digit: string) => void)[] = [];
  private _dtmfBuffer: string[] = [];
  private _log: Logger = NOOP_LOGGER;
  private _handlers: Map<string, SessionEventHandler[]> = new Map();
  private _endedPromise: Promise<void>;
  private _resolveEnded!: () => void;
  private _metrics: CallMetrics = createCallMetrics();
  private _firstResponseSent = false;

  constructor(options: {
    callId: string;
    fromNumber: string;
    toNumber: string;
    accountId: string;
    direction: CallDirection;
    metadata?: Record<string, unknown>;
  }) {
    this.callId = options.callId;
    this.fromNumber = options.fromNumber;
    this.toNumber = options.toNumber;
    this.accountId = options.accountId;
    this.direction = options.direction;
    this.metadata = options.metadata ?? {};
    this._status = 'ringing';
    this.startTime = new Date();

    this._endedPromise = new Promise<void>((resolve) => {
      this._resolveEnded = resolve;
    });
  }

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  get status(): CallStatus {
    return this._status;
  }

  get duration(): number {
    return (Date.now() - this.startTime.getTime()) / 1000;
  }

  get metrics(): Readonly<CallMetrics> { return this._metrics; }

  recordFirstResponse(): void {
    if (!this._firstResponseSent) {
      this._firstResponseSent = true;
      this._metrics.firstResponseMs = Date.now() - this.startTime.getTime();
    }
  }
  recordTurn(): void { this._metrics.turnCount++; }
  recordToolCall(): void { this._metrics.toolCallCount++; }
  recordToolError(err: Error): void { addMetricError(this._metrics, err); }
  recordBargeIn(): void { this._metrics.bargeInCount++; }
  recordEndReason(reason: string): void { this._metrics.endReason = reason; }

  /** Bind transport functions (called internally by the agent). */
  _bindTransport(
    send: SendAudioFn,
    clear: ClearAudioFn,
    hangup: HangupFn,
    sendDtmf?: SendDtmfFn,
    isConnected?: () => boolean,
  ): void {
    this._sendAudioFn = send;
    this._clearAudioFn = clear;
    this._hangupFn = hangup;
    if (sendDtmf) this._sendDtmfFn = sendDtmf;
    if (isConnected) this._isTransportConnected = isConnected;
    this._status = 'active';
  }

  /** Send PCM16 or ulaw audio to the caller. */
  sendAudio(audio: Buffer): void {
    if (this._sendAudioFn) {
      this._sendAudioFn(audio);
    }
  }

  /** Clear any queued outbound audio. */
  clearAudio(): void {
    if (this._clearAudioFn) {
      this._clearAudioFn();
    }
  }

  /** Hang up the call, waiting for pending audio to finish. */
  async hangup(): Promise<void> {
    if (this._hangupFn) {
      await this._hangupFn();
    }
  }

  /** @internal Route a received DTMF digit to an active collector or buffer. */
  _routeDtmf(digit: string): void {
    if (this._dtmfCollectorActive && this._dtmfResolvers.length > 0) {
      const resolve = this._dtmfResolvers.shift()!;
      resolve(digit);
    } else {
      // Buffer the digit — collector may not be active yet (tool call timing)
      this._dtmfBuffer.push(digit);
    }
  }

  /** Collect DTMF digits from the caller. */
  async collectDtmf(options: {
    maxDigits: number;
    finishOnKey?: string;
    timeout?: number;
    secure?: boolean;
  }): Promise<string> {
    if (this._dtmfCollectorActive) {
      throw new Error('이미 DTMF 수집 중입니다');
    }

    const { maxDigits, finishOnKey = '#', timeout = 5 } = options;
    this._dtmfCollectorActive = true;
    // Don't clear buffer — digits may have arrived before tool call was processed
    const collected: string[] = [];

    try {
      while (collected.length < maxDigits) {
        // Drain the buffer first
        if (this._dtmfBuffer.length > 0) {
          const digit = this._dtmfBuffer.shift()!;
          if (digit === finishOnKey) break;
          collected.push(digit);
          continue;
        }

        const digit = await Promise.race([
          new Promise<string>((resolve) => {
            this._dtmfResolvers.push(resolve);
          }),
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), timeout * 1000);
          }),
        ]);

        if (digit === null) break; // timeout
        if (digit === finishOnKey) break;
        collected.push(digit);
      }
    } finally {
      this._dtmfCollectorActive = false;
      this._dtmfResolvers = [];
      this._dtmfBuffer = [];
    }

    const result = collected.join('');
    this._log.info('DTMF collected: %s', result);
    return result;
  }

  /** Send a sequence of DTMF digits. */
  async sendDtmfSequence(digits: string): Promise<void> {
    if (!this._sendDtmfFn) {
      throw new Error('DTMF 전송 함수가 바인딩되지 않았습니다');
    }
    for (const ch of digits) {
      if (this._isTransportConnected && !this._isTransportConnected()) {
        throw new Error('DTMF 전송 중 연결이 끊어졌습니다');
      }
      if (ch === 'w') {
        await new Promise((r) => setTimeout(r, 500));
      } else if (ch === 'W') {
        await new Promise((r) => setTimeout(r, 1000));
      } else if ('0123456789*#'.includes(ch)) {
        if (this._sendDtmfFn) {
          await this._sendDtmfFn(ch);
        }
      } else {
        throw new Error(`유효하지 않은 DTMF 문자: ${ch}`);
      }
    }
  }

  /** Register an event handler. */
  on(event: string, handler: SessionEventHandler): void {
    let list = this._handlers.get(event);
    if (!list) {
      list = [];
      this._handlers.set(event, list);
    }
    list.push(handler);
  }

  /** Wait for the call to end. */
  async wait(): Promise<void> {
    return this._endedPromise;
  }

  /** Mark the session as ended (called internally). */
  _markEnded(): void {
    this._status = 'ended';
    this._resolveEnded();
  }

  /** Emit an event to registered handlers. Matches Python SDK: _emit(event, ...args) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _emit(event: string, ...args: any[]): void {
    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(this, ...args);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => {
              this._log.error({ err }, 'CallSession handler error: %s', event);
            });
          }
        } catch (err) {
          this._log.error({ err }, 'CallSession handler error: %s', event);
        }
      }
    }
  }
}
