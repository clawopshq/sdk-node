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

export interface TransferFn {
  (params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * `collectDtmf` 가 이미 돌고 있는데 또 불렸다.
 *
 * 실시간 모델은 도구를 **중복으로 호출한다** — 앞 호출이 아직 자리를 기다리는 동안 같은
 * 도구를 한 번 더 낸다(2026-09-03 실통화에서 관측). 이걸 맨 `Error` 로 던지면 도구 래퍼가
 * `"Error: ..."` 로 감싸 모델에게 돌려주고, 모델은 뭔가 고장난 줄 알고 **그 뒤로 도구를
 * 다시 부르지 않는다.** 그러면 발신자가 누르는 키는 아무도 받지 않는다.
 *
 * `Error` 를 상속하므로 기존에 이걸 잡던 코드는 그대로 돈다. 도구 경로만 이 타입을 따로
 * 잡아 "고장"이 아니라 "기다리라"는 뜻으로 옮긴다.
 */
export class DtmfCollectorBusyError extends Error {
  constructor(message = '이미 DTMF 수집 중입니다') {
    super(message);
    this.name = 'DtmfCollectorBusyError';
  }
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
  private _endedStatus: string | null = null;
  private _endedDuration: number | null = null;
  private _sendAudioFn: SendAudioFn | null = null;
  private _clearAudioFn: ClearAudioFn | null = null;
  private _hangupFn: HangupFn | null = null;
  /** @internal */ _sendDtmfFn: SendDtmfFn | null = null;
  /** @internal */ _transferFn: TransferFn | null = null;
  /** @internal */ _isTransportConnected: (() => boolean) | null = null;
  /**
   * @internal Media WS playout 마커 훅. LiveKit(`ClawOpsAudioOutput`)이 재생 완료
   * 판정(mark echo)과 barge-in 절단 위치 계산에 쓴다. 다른 세션 타입은 읽지 않는다.
   * prewarm 중(BufferingCall)에는 바인딩되지 않아 null 이다.
   */
  /** @internal */ _sendMark: ((name: string) => void) | null = null;
  /** @internal */ _waitForMark: ((name: string, timeoutMs: number) => Promise<void>) | null = null;
  /** @internal */ _flushTransport: (() => Promise<void>) | null = null;
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

  /**
   * 서버가 통보한 최종 종료 상태. 통화가 끝나기 전에는 null.
   *
   * `completed`(성사) / `no-answer`(벨은 울렸으나 무응답) / `busy`(통화중) /
   * `rejected`(수신 거절) / `canceled`(응답 전 발신 측 취소) / `failed`(시스템·망 오류).
   * `status` 는 SDK 내부 수명주기(ringing→active→ended)이므로 통화 성사 여부는
   * 이 값이나 `call_failed` 이벤트로 판단한다.
   */
  get endedStatus(): string | null {
    return this._endedStatus;
  }

  /**
   * 서버가 확정한 통화 시간(초). 통화가 끝나기 전에는 `null`.
   *
   * ⚠️ `duration` 과 다르다 — 그쪽은 SDK 가 로컬 시계로 재는 **경과 시간**이라 통화 중에도
   * 읽히고, 세션이 붙기 전후의 오차를 포함한다. 기록·정산에 쓸 값은 이쪽이다.
   */
  get endedDuration(): number | null {
    return this._endedDuration;
  }

  get duration(): number {
    return (Date.now() - this.startTime.getTime()) / 1000;
  }

  /** @internal 서버가 통보한 통화 시간을 확정한다. */
  _setEndedDuration(seconds: number): void {
    this._endedDuration = seconds;
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

  /**
   * Send G.711 μ-law audio (8kHz, mono) to the caller.
   *
   * NOT PCM16. The transport applies μ-law gain and forwards the bytes as-is,
   * so PCM16 input is reinterpreted as μ-law and plays as noise. Convert first.
   */
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

  /**
   * Collect DTMF digits from the caller.
   *
   * `timeout` 은 **자리 사이** 대기다(inter-digit). `<Gather>` 를 비롯한 IVR 관행과 같은
   * 의미이고, 자리가 들어올 때마다 다시 시작한다.
   *
   * `maxWait` 는 그 관행이 만드는 최악을 막는 **전체 상한**이다(기본 30초). 자리마다
   * 리셋되는 타이머만 있으면 수집 하나가 최대 `maxDigits × timeout` 동안 산다 —
   * 11자리·5초면 **55초**이고, 그동안 모델은 이 도구에 붙들려 아무 말도 못 한다.
   * `null` 을 주면 상한 없이 종전대로 돈다.
   *
   * ⚠️ **수집값을 로그에 쓰지 않는다.** 키패드로 받는 값은 카드번호·주민번호일 수 있고,
   * 실제로 그런 구성이 있다. `secure` 와 무관하게 **자릿수만** 남긴다 — 이 옵션은 호환을
   * 위해 남아 있을 뿐 로깅을 좌우하지 않는다.
   */
  async collectDtmf(options: {
    maxDigits: number;
    finishOnKey?: string;
    timeout?: number;
    secure?: boolean;
    maxWait?: number | null;
  }): Promise<string> {
    if (this._dtmfCollectorActive) {
      throw new DtmfCollectorBusyError();
    }

    const { maxDigits, finishOnKey = '#', timeout = 5, maxWait = 30 } = options;
    this._dtmfCollectorActive = true;
    // Don't clear buffer — digits may have arrived before tool call was processed
    const collected: string[] = [];
    const deadline = maxWait === null ? null : Date.now() + maxWait * 1000;

    try {
      while (collected.length < maxDigits) {
        // Drain the buffer first
        if (this._dtmfBuffer.length > 0) {
          const digit = this._dtmfBuffer.shift()!;
          if (digit === finishOnKey) break;
          collected.push(digit);
          continue;
        }

        let waitMs = timeout * 1000;
        if (deadline !== null) {
          // 남은 예산이 자리 간 대기보다 짧으면 그만큼만 기다린다. 0 이하면 전체 상한에
          // 닿은 것이라 지금까지 모인 값으로 확정한다.
          waitMs = Math.min(waitMs, deadline - Date.now());
          if (waitMs <= 0) break;
        }

        // ⚠️ 진 쪽 타이머를 **반드시 지운다.** Promise.race 는 진 promise 를 취소하지
        //    않으므로, clear 하지 않으면 자리마다 타이머가 하나씩 살아남아 최대 timeout
        //    초 동안 이벤트 루프를 붙잡는다(통화가 끝나도 프로세스가 안 죽는다).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const digit = await Promise.race([
          new Promise<string>((resolve) => {
            this._dtmfResolvers.push(resolve);
          }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), waitMs);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });

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
    this._log.info('DTMF collected: %d digits', result.length);
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

  /**
   * Transfer the call to a phone number or SIP endpoint.
   *
   * destinationType='pstn' (default): `to` is a phone number dialed via carrier.
   * destinationType='sip': `to` is a SIP URI (e.g. `sip:user@host`) connected
   * directly to a SIP endpoint without going through the PSTN carrier. Requires the
   * account to have an active `sip_trunk` add-on; otherwise the transfer fails and
   * the call continues with the AI (result `{ status: 'failed', ... }`).
   *
   * 전환받는 쪽에 표시되는 발신번호는 기본이 **계정 보유번호**(인바운드면 착신 070)다.
   *
   * `callerIdMode: 'original'` 은 인바운드 통화의 **원 발신자 번호를 승계하려는 선호**다.
   * 승계할 수 없는 통화(KCT 직결 인입이 아니거나 국내 번호로 정규화되지 않는 발신번호)면
   * 조용히 계정 보유번호로 내려앉고 **전환은 그대로 성사된다**.
   *
   * `callerId` 는 번호를 직접 주는 **지시**라 성격이 다르다. 허용 범위(계정 보유번호 또는
   * KCT 직결 인입의 원 발신자)를 벗어나면 전환 자체가 실패한다. 둘 다 주면 `callerId` 가
   * 이기고 `callerIdMode` 는 무시된다 — 우선순위 판단은 서버가 한다.
   */
  async transfer(
    to: string,
    options?: {
      destinationType?: 'pstn' | 'sip';
      mode?: 'blind' | 'warm';
      afterTransfer?: 'terminate' | 'return';
      holdMedia?: string;
      whisper?: string;
      context?: Record<string, unknown>;
      callerId?: string;
      callerIdMode?: 'account' | 'original';
      timeout?: number;
    },
  ): Promise<Record<string, unknown>> {
    if (!this._transferFn) {
      throw new Error('transfer not available');
    }
    // 서버는 'original' 만 특별 취급하고 나머지 값은 조용히 무시한다. 오타를 그대로
    // 흘려보내면 아무 에러 없이 계정 번호가 나가고, 개발자는 켰다고 믿는다 — 여기서 막는다.
    const callerIdMode = options?.callerIdMode;
    if (callerIdMode !== undefined && callerIdMode !== 'account' && callerIdMode !== 'original') {
      throw new Error(
        `callerIdMode must be 'account' or 'original', got ${JSON.stringify(callerIdMode)}`,
      );
    }
    return this._transferFn({
      to,
      destinationType: options?.destinationType ?? 'pstn',
      mode: options?.mode ?? 'blind',
      afterTransfer: options?.afterTransfer ?? 'terminate',
      holdMedia: options?.holdMedia ?? 'ringback',
      whisper: options?.whisper ?? null,
      context: options?.context ?? null,
      callerId: options?.callerId ?? null,
      timeout: options?.timeout ?? 30,
      // 안 주면 키를 붙이지 않는다 — 구 서버와 기존 동작을 그대로 둔다(additive).
      ...(callerIdMode !== undefined ? { callerIdMode } : {}),
    });
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

  /**
   * Mark the session as ended (called internally).
   *
   * @param status 서버가 통보한 최종 상태(completed/no-answer/busy/rejected/canceled/
   *   failed). 주어지면 `endedStatus` 로 확정한다 — 상대가 받지 않은 통화를 성사된 통화와
   *   구분하기 위함이다. 생략하면 미디어 세션 정리 경로에서의 호출이므로, 아직 종료 전일
   *   때만 'completed' 로 채우고 이미 확정된 서버 상태는 덮어쓰지 않는다.
   */
  _markEnded(status?: string): void {
    if (status !== undefined) {
      this._endedStatus = status;
    } else if (this._status !== 'ended') {
      this._endedStatus = 'completed';
    }
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
