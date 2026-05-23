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
  readonly metrics = new MetricsStub();

  async sendAudio(chunk: Buffer): Promise<void> {
    this._buffer.push(chunk);
  }

  /** clearAudio 도 prewarm 동안엔 no-op (드물긴 하지만 안전하게). */
  clearAudio(): void {
    this._buffer = [];
  }

  /** transcript 등 lifecycle 이벤트는 prewarm 동안 무시. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _emit(..._args: unknown[]): void {
    // no-op during prewarm
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async emit(..._args: unknown[]): Promise<void> {
    // no-op during prewarm
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
}

/**
 * prewarm → attach 전환 시 BufferingCall 에 쌓인 audio chunk 를 실제
 * CallSession 으로 flush 하는 공통 헬퍼. OpenAI / Gemini / PipelineSession
 * attach() 가 동일 패턴이므로 한 곳에서 관리한다.
 */
export function attachBuffered(
  prev: BufferingCall | CallSession | null,
  next: CallSession,
): void {
  if (prev instanceof BufferingCall) {
    for (const chunk of prev.drainBuffer()) {
      next.sendAudio(chunk);
    }
  }
}
