/**
 * CallSession represents an active phone call and provides methods to
 * send audio, hang up, and listen for lifecycle events.
 */

export type CallDirection = 'inbound' | 'outbound';
export type CallStatus = 'ringing' | 'active' | 'ended';
export type SessionEventType = 'ended' | 'dtmf' | 'speech';

export interface SessionEvent {
  type: SessionEventType;
  data?: unknown;
}

type SessionEventHandler = (event: SessionEvent) => void | Promise<void>;

export interface SendAudioFn {
  (audio: Buffer): void;
}

export interface ClearAudioFn {
  (): void;
}

export interface HangupFn {
  (): void;
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
  private _handlers: Map<SessionEventType, SessionEventHandler[]> = new Map();
  private _endedPromise: Promise<void>;
  private _resolveEnded!: () => void;

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

  get status(): CallStatus {
    return this._status;
  }

  get duration(): number {
    return (Date.now() - this.startTime.getTime()) / 1000;
  }

  /** Bind transport functions (called internally by the agent). */
  _bindTransport(send: SendAudioFn, clear: ClearAudioFn, hangup: HangupFn): void {
    this._sendAudioFn = send;
    this._clearAudioFn = clear;
    this._hangupFn = hangup;
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

  /** Hang up the call. */
  hangup(): void {
    if (this._hangupFn) {
      this._hangupFn();
    }
  }

  /** Register an event handler. */
  on(event: SessionEventType, handler: SessionEventHandler): void {
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
    this._emit({ type: 'ended' });
    this._resolveEnded();
  }

  /** Emit an event to registered handlers. */
  _emit(event: SessionEvent): void {
    const handlers = this._handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => {
              console.error(`[CallSession] Error in ${event.type} handler:`, err);
            });
          }
        } catch (err) {
          console.error(`[CallSession] Error in ${event.type} handler:`, err);
        }
      }
    }
  }
}
