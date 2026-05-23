/**
 * prewarm 단계에서 사용되는 CallSession stub.
 *
 * Session 구현체가 sendAudio() 를 호출하면 메모리 버퍼에 누적한다.
 * attach() 시점에 drainBuffer() 로 꺼내 실제 CallSession 에 flush.
 *
 * Python SDK 의 `_BufferingCall` mirror.
 */

import type { CallSession } from '../session.js';

class MetricsStub {
  recordToolCall(): void {}
  recordInterrupt(): void {}
  recordToolError(): void {}
}

export class BufferingCall {
  private _buffer: Buffer[] = [];
  private _droppedEvents: Record<string, number> = {};
  readonly metrics = new MetricsStub();

  async sendAudio(chunk: Buffer): Promise<void> {
    this._buffer.push(chunk);
  }

  /** clearAudio 도 prewarm 동안엔 no-op (드물긴 하지만 안전하게). */
  clearAudio(): void {
    this._buffer = [];
  }

  /**
   * transcript 등 lifecycle 이벤트는 prewarm 동안 무시한다. silent drop 은 디버깅이
   * 어려우므로 event name 별 카운터로 누적하고 attachBuffered() 시 한 번에 로깅한다.
   */
  _emit(...args: unknown[]): void {
    this._recordDropped(args);
  }

  async emit(...args: unknown[]): Promise<void> {
    this._recordDropped(args);
  }

  private _recordDropped(args: unknown[]): void {
    let eventName = '?';
    if (args.length > 0 && typeof args[0] === 'string') {
      eventName = args[0];
    }
    this._droppedEvents[eventName] = (this._droppedEvents[eventName] ?? 0) + 1;
  }

  recordToolCall(): void {}
  recordToolError(): void {}
  recordFirstResponse(): void {}
  recordBargeIn(): void {}

  drainBuffer(): Buffer[] {
    const out = this._buffer;
    this._buffer = [];
    return out;
  }

  drainDroppedEvents(): Record<string, number> {
    const out = this._droppedEvents;
    this._droppedEvents = {};
    return out;
  }
}

/**
 * prewarm → attach 전환 시 BufferingCall 에 쌓인 audio chunk 를 실제
 * CallSession 으로 flush 하는 공통 헬퍼. OpenAI / Gemini / PipelineSession
 * attach() 가 동일 패턴이므로 한 곳에서 관리한다.
 *
 * 반환값: 한 개 이상의 chunk 를 drain 했으면 true. drain 시 PREWARM-T first-audio
 * 마커를 한 번 emit 한다. drained 가 비어 있으면 false 를 반환하여 호출자(Session)
 * 가 첫 실시간 audio.delta 송출 시 logFirstRealtimeAudio() 로 한 번만 마커를 찍을
 * 수 있게 한다.
 */
export function attachBuffered(
  prev: BufferingCall | CallSession | null,
  next: CallSession,
): boolean {
  if (!(prev instanceof BufferingCall)) {
    return false;
  }

  const drained = prev.drainBuffer();
  const flushed = drained.length > 0;
  const callId = (next as { callId?: string }).callId ?? '?';

  if (flushed) {
    // eslint-disable-next-line no-console
    console.info(
      `[PREWARM-T] first-audio call_id=${callId} ` +
        `t=${(process.hrtime.bigint() / 1_000_000n).toString()} ` +
        `buffered_chunks=${drained.length} source=prebuffer`,
    );
  }
  for (const chunk of drained) {
    next.sendAudio(chunk);
  }

  const dropped = prev.drainDroppedEvents();
  if (Object.keys(dropped).length > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[PREWARM] dropped events during prewarm call_id=${callId} events=${JSON.stringify(dropped)}`,
    );
  }
  return flushed;
}

/**
 * prewarm prebuffer 가 비어 있던 케이스에서 첫 실시간 audio chunk 송출 시 호출.
 * 호출자(Session)는 attachBuffered() 반환값과 자체 플래그로 한 번만 호출하도록
 * 가드해야 한다.
 */
export function logFirstRealtimeAudio(call: { callId?: string } | null): void {
  const callId = call?.callId ?? '?';
  // eslint-disable-next-line no-console
  console.info(
    `[PREWARM-T] first-audio call_id=${callId} ` +
      `t=${(process.hrtime.bigint() / 1_000_000n).toString()} ` +
      `buffered_chunks=0 source=realtime`,
  );
}
