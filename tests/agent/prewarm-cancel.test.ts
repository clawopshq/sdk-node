import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OpenAIRealtime } from '../../src/agent/pipeline/realtime/openai-realtime.js';
import { GeminiRealtime } from '../../src/agent/pipeline/realtime/gemini-realtime.js';

// ── ws mock (per-test fresh instance bookkeeping) ────────────────────────────
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
  /** synchronously emit close — simulates well-behaved server. */
  close(): void {
    this.closed = true;
    queueMicrotask(() => {
      for (const fn of this._handlers.get('close') ?? []) fn();
    });
  }
}
vi.mock('ws', () => ({ WebSocket: MockWs }));

// ── @google/genai mock ───────────────────────────────────────────────────────
const mockGeminiSession = {
  sendRealtimeInput: vi.fn(),
  sendClientContent: vi.fn(),
  sendToolResponse: vi.fn(),
  close: vi.fn(),
};
const mockConnect = vi.fn().mockResolvedValue(mockGeminiSession);
const mockGenAI = {
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    live: { connect: mockConnect },
  })),
};
vi.mock('@google/genai', () => mockGenAI);
vi.mock('@google/genai/node', () => mockGenAI);

// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAIRealtime prewarm cancel / stop', () => {
  beforeEach(() => {
    mockWsInstances = [];
  });

  it('prewarm() then stop() closes the WS without attach', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    await sess.prewarm();
    expect(mockWsInstances).toHaveLength(1);
    const ws = mockWsInstances[0]!;
    expect(ws.closed).toBe(false);
    await sess.stop();
    expect(ws.closed).toBe(true);
    // _ws ref is cleared
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._ws).toBeNull();
  });

  it('stop() returns within 2.5s even if WS close hangs (timeout guard)', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    await sess.prewarm();
    const ws = mockWsInstances[0]!;
    // override close to never emit 'close' event — simulate hung server.
    ws.close = () => {
      ws.closed = true;
      // no event
    };
    const t0 = Date.now();
    await sess.stop();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2500);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  }, 5000);
});

describe('GeminiRealtime prewarm cancel / stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGeminiSession.close = vi.fn();
  });

  it('prewarm() then stop() closes the Live session', async () => {
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });
    await sess.prewarm();
    await sess.stop();
    expect(mockGeminiSession.close).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._session).toBeNull();
  });

  it('stop() returns within 2.5s even if close() hangs (timeout guard)', async () => {
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });
    await sess.prewarm();
    mockGeminiSession.close = vi.fn(
      () => new Promise<void>(() => {}), // never resolves
    );
    const t0 = Date.now();
    await sess.stop();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2500);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  }, 5000);
});
