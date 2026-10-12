/**
 * 수신 통화 선별 — `agent.onIncoming(hook)` 이 받는 객체 (clawops#1251).
 *
 * 받기 **전에** 서버가 보낸 `call.incoming` 을 보고 거절할지 정한다. 이 객체는 `CallSession` 이
 * 아니다 — 아직 받지 않은 통화라 미디어도, 세션도 없다. 거절하면 세션이 아예 만들어지지 않는다.
 *
 * 와이어:
 *   서버 → `{ event: 'call.incoming', callId, from, to, mediaUrl, callerIdRestricted? }`
 *   SDK  → `{ event: 'call.accept', callId }` 또는 `{ event: 'call.reject', callId, reason }`
 *
 * `call.reject` 에는 **반드시 reason 을 싣는다.** reason 없는 거절은 서버가 「에이전트 응답 실패」로
 * 보고 대체 경로로 넘긴다 — 고객이 원한 「끊기」가 아니다.
 */

import type { Logger } from 'pino';
import { AgentError } from '../error.js';
import { NOOP_LOGGER } from './logger.js';

/** 거절 사유. `'rejected'` = SIP 403(기본), `'busy'` = SIP 486(통화중). */
export type IncomingRejectReason = 'rejected' | 'busy';

export interface IncomingRejectOptions {
  /** 기본 `'rejected'`. */
  reason?: IncomingRejectReason;
}

/** `agent.onIncoming()` 에 넘기는 선별 함수. reject 하지 않고 돌아오면 받는다. */
export type IncomingHandler = (call: IncomingCall) => void | Promise<void>;

const VALID_REASONS: ReadonlySet<string> = new Set<IncomingRejectReason>(['rejected', 'busy']);

/** @internal */
export interface IncomingCallInit {
  callId: string;
  fromNumber: string;
  toNumber: string;
  callerIdRestricted: boolean;
  /** 거절이 확정되는 순간 한 번 불린다 — `call.reject` 를 보내는 자리. */
  onReject: (reason: IncomingRejectReason) => void;
  logger?: Logger;
}

export class IncomingCall {
  /** 통화 ID */
  readonly callId: string;
  /** 발신 번호 (`CallSession.fromNumber` 와 같은 값) */
  readonly fromNumber: string;
  /** 수신 번호 (`CallSession.toNumber` 와 같은 값) */
  readonly toNumber: string;
  /** 발신자가 번호 표시제한을 걸고 건 통화면 `true`. 통신사가 표시제한 여부를 안 보낸 통화는 `false`. */
  readonly callerIdRestricted: boolean;

  private _state: 'pending' | 'rejected' | 'closed' = 'pending';
  private _reason: IncomingRejectReason | null = null;
  private readonly _onReject: (reason: IncomingRejectReason) => void;
  private readonly _log: Logger;

  /** @internal — SDK 가 만든다. */
  constructor(init: IncomingCallInit) {
    this.callId = init.callId;
    this.fromNumber = init.fromNumber;
    this.toNumber = init.toNumber;
    this.callerIdRestricted = init.callerIdRestricted;
    this._onReject = init.onReject;
    this._log = init.logger ?? NOOP_LOGGER;
  }

  /** 거절했으면 `true`. */
  get rejected(): boolean {
    return this._state === 'rejected';
  }

  /** 거절 사유. 거절하지 않았으면 `null`. */
  get rejectReason(): IncomingRejectReason | null {
    return this._reason;
  }

  /**
   * 이 통화를 받지 않고 끝낸다. 과금되지 않고, 대체 경로로도 넘어가지 않는다.
   *
   * - 두 번 불러도 처음 한 번만 보낸다.
   * - 선별 시간(5초)이 지난 뒤에는 이미 받은 통화라 아무것도 하지 않는다(경고만 남긴다).
   * - `reason` 이 `'rejected'`·`'busy'` 가 아니면 예외를 던진다.
   */
  async reject(opts: IncomingRejectOptions = {}): Promise<void> {
    const reason = opts.reason ?? 'rejected';
    if (!VALID_REASONS.has(reason)) {
      throw new AgentError(
        `IncomingCall.reject: reason 은 'rejected' 또는 'busy' 여야 합니다 (받은 값: ${String(reason)}).`,
      );
    }
    if (this._state === 'rejected') return;
    if (this._state === 'closed') {
      this._log.warn(
        { callId: this.callId, reason },
        'IncomingCall.reject() 가 선별 시간이 지난 뒤 불렸다 — 이미 받은 통화라 무시한다',
      );
      return;
    }
    this._state = 'rejected';
    this._reason = reason;
    this._onReject(reason);
  }

  /** @internal — 선별이 끝나 받기로 확정됐다. 이후 reject() 는 no-op. */
  _close(): void {
    if (this._state === 'pending') this._state = 'closed';
  }
}
