import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OpenAIRealtime } from '../../src/agent/pipeline/realtime/openai-realtime.js';
import { BufferingCall } from '../../src/agent/pipeline/buffering-call.js';

// Mock 'ws' WebSocket — auto-resolves 'open' on next microtask
type Handler = (...args: unknown[]) => void;
let mockInstances: MockWs[] = [];

class MockWs {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private _handlers = new Map<string, Handler[]>();

  constructor() {
    mockInstances.push(this);
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
    const arr = this._handlers.get('close') ?? [];
    for (const fn of arr) fn();
  }
}

vi.mock('ws', () => ({ WebSocket: MockWs }));

describe('OpenAIRealtime prewarm/attach', () => {
  beforeEach(() => {
    mockInstances = [];
  });

  it('prewarm opens WS without CallSession and installs BufferingCall', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    await sess.prewarm();
    // BufferingCall must be wired in as the _call slot
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._call).toBeInstanceOf(BufferingCall);
    expect(mockInstances).toHaveLength(1);
    // session.update should have been sent on open
    const types = mockInstances[0]!.sent.map((s) => JSON.parse(s).type as string);
    expect(types).toContain('session.update');
    expect(types).not.toContain('response.create');
  });

  it('prewarm with greeting=true also sends response.create', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: true });
    await sess.prewarm();
    const types = mockInstances[0]!.sent.map((s) => JSON.parse(s).type as string);
    expect(types).toContain('response.create');
  });

  it('attach replaces BufferingCall and flushes buffered audio', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    await sess.prewarm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bc = (sess as any)._call as BufferingCall;
    await bc.sendAudio(Buffer.from('aaa'));
    await bc.sendAudio(Buffer.from('bbb'));

    const sendAudio = vi.fn();
    const realCall = {
      sendAudio,
      _emit: vi.fn(),
      clearAudio: vi.fn(),
      recordFirstResponse: vi.fn(),
      metrics: { recordToolCall: vi.fn() },
    } as never;
    await sess.attach(realCall);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._call).toBe(realCall);
    expect(sendAudio).toHaveBeenCalledTimes(2);
    expect(sendAudio).toHaveBeenNthCalledWith(1, Buffer.from('aaa'));
    expect(sendAudio).toHaveBeenNthCalledWith(2, Buffer.from('bbb'));
  });

  it('start(call) is equivalent to prewarm + attach', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    const prewarmSpy = vi.spyOn(sess, 'prewarm');
    const attachSpy = vi.spyOn(sess, 'attach');
    const realCall = {
      sendAudio: vi.fn(),
      _emit: vi.fn(),
      clearAudio: vi.fn(),
      recordFirstResponse: vi.fn(),
      metrics: { recordToolCall: vi.fn() },
    } as never;
    await sess.start(realCall);
    expect(prewarmSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledWith(realCall);
  });
});
