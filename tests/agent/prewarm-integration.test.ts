import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OpenAIRealtime } from '../../src/agent/pipeline/realtime/openai-realtime.js';
import { BufferingCall } from '../../src/agent/pipeline/buffering-call.js';

type Handler = (...args: unknown[]) => void;
let mockWsInstances: MockWs[] = [];

class MockWs {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private _handlers = new Map<string, Handler[]>();
  constructor() {
    mockWsInstances.push(this);
  }
  on(event: string, fn: Handler): this {
    const arr = this._handlers.get(event) ?? [];
    arr.push(fn);
    this._handlers.set(event, arr);
    if (event === 'open') queueMicrotask(() => fn());
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    queueMicrotask(() => {
      for (const fn of this._handlers.get('close') ?? []) fn();
    });
  }
}
vi.mock('ws', () => ({ WebSocket: MockWs }));

describe('prewarm → attach end-to-end (OpenAI Realtime)', () => {
  beforeEach(() => {
    mockWsInstances = [];
  });

  it('greeting deltas accumulate during prewarm and flush on attach', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: true });
    await sess.prewarm();

    // After prewarm, _call is a BufferingCall and session.update + response.create
    // have been queued onto the mock WS.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._call).toBeInstanceOf(BufferingCall);
    const types = mockWsInstances[0]!.sent.map((s) => JSON.parse(s).type as string);
    expect(types).toContain('session.update');
    expect(types).toContain('response.create');

    // Simulate two audio deltas arriving from the model during the prewarm window.
    // We push them directly into the BufferingCall since the test stub doesn't
    // round-trip messages through the mock WS.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bc = (sess as any)._call as BufferingCall;
    await bc.sendAudio(Buffer.from('greet-chunk-1'));
    await bc.sendAudio(Buffer.from('greet-chunk-2'));

    // Now the media WS connects and we attach a real CallSession.
    const realCall = {
      sendAudio: vi.fn(),
      _emit: vi.fn(),
      clearAudio: vi.fn(),
      recordFirstResponse: vi.fn(),
      metrics: { recordToolCall: vi.fn() },
    } as never;
    await sess.attach(realCall);

    // Buffered greeting deltas should land on the real CallSession in order.
    expect(realCall.sendAudio).toHaveBeenCalledTimes(2);
    expect(realCall.sendAudio).toHaveBeenNthCalledWith(1, Buffer.from('greet-chunk-1'));
    expect(realCall.sendAudio).toHaveBeenNthCalledWith(2, Buffer.from('greet-chunk-2'));
    // _call slot now points at the real call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._call).toBe(realCall);
  });
});
