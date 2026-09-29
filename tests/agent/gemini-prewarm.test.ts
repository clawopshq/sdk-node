import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GeminiRealtime } from '../../src/agent/pipeline/realtime/gemini-realtime.js';
import { BufferingCall } from '../../src/agent/pipeline/buffering-call.js';

const mockSession = {
  sendRealtimeInput: vi.fn(),
  sendClientContent: vi.fn(),
  sendToolResponse: vi.fn(),
  close: vi.fn(),
};

// 실제 서버처럼 연결 직후 setupComplete 를 보낸다 — prewarm 은 이걸 받아야 끝난다.
const mockConnect = vi.fn().mockImplementation(async ({ callbacks }) => {
  queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
  return mockSession;
});

const mockGenAI = {
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    live: { connect: mockConnect },
  })),
};

vi.mock('@google/genai', () => mockGenAI);
vi.mock('@google/genai/node', () => mockGenAI);

describe('GeminiRealtime prewarm/attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prewarm opens live session without CallSession', async () => {
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });
    await sess.prewarm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._call).toBeInstanceOf(BufferingCall);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._session).toBe(mockSession);
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
  });

  it('prewarm with greeting=true sends initial text', async () => {
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: true });
    await sess.prewarm();
    expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({ text: '인사해 주세요.' });
  });

  it('attach flushes BufferingCall into real CallSession', async () => {
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });
    await sess.prewarm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bc = (sess as any)._call as BufferingCall;
    await bc.sendAudio(Buffer.from('xx'));

    const sendAudio = vi.fn();
    const realCall = {
      sendAudio,
      _emit: vi.fn(),
      clearAudio: vi.fn(),
      metrics: { recordToolCall: vi.fn() },
    } as never;
    await sess.attach(realCall);
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from('xx'));
  });

  it('start = prewarm + attach', async () => {
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });
    const prewarmSpy = vi.spyOn(sess, 'prewarm');
    const attachSpy = vi.spyOn(sess, 'attach');
    const realCall = {
      sendAudio: vi.fn(),
      _emit: vi.fn(),
      clearAudio: vi.fn(),
      metrics: { recordToolCall: vi.fn() },
    } as never;
    await sess.start(realCall);
    expect(prewarmSpy).toHaveBeenCalledOnce();
    expect(attachSpy).toHaveBeenCalledOnce();
    expect(attachSpy).toHaveBeenCalledWith(realCall);
  });
});

describe('GeminiRealtime prewarm — setup 실패는 조용히 지나가지 않는다', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with the server reason when the server closes before setupComplete', async () => {
    // 실측: gemini-3.8-live-extended-thinking 을 thinkingConfig 없이 열면 연결은 열리고
    // 곧바로 1007 로 끊긴다. 예전엔 prewarm 이 성공으로 끝나고 통화가 무음이 됐다.
    mockConnect.mockImplementationOnce(async ({ callbacks }) => {
      queueMicrotask(() =>
        callbacks.onclose({
          code: 1007,
          reason: 'Thinking level must be specified for this model.',
        }),
      );
      return mockSession;
    });
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });

    await expect(sess.prewarm()).rejects.toThrow(
      'Gemini Live closed before setup completed (code 1007: Thinking level must be specified for this model.)',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._session).toBeNull();
  });

  it('rejects when the socket errors before it ever opens (connect never resolves)', async () => {
    // @google/genai 의 live.connect() 는 onopen 에서만 resolve 한다 — 열리기 전 에러면 영원히 pending.
    mockConnect.mockImplementationOnce(({ callbacks }) => {
      queueMicrotask(() => callbacks.onerror(new Error('handshake failed')));
      return new Promise(() => {});
    });
    const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });

    await expect(sess.prewarm()).rejects.toThrow('Gemini Live connection error');
  });

  it('times out when setupComplete never arrives', async () => {
    vi.useFakeTimers();
    try {
      mockConnect.mockImplementationOnce(async () => mockSession);
      const sess = new GeminiRealtime({ apiKey: 'g-test', greeting: false });

      const p = sess.prewarm();
      const assertion = expect(p).rejects.toThrow('Gemini Live setup timed out after 15000ms');
      // prewarm 은 @google/genai/node 를 동적 import 한 뒤에야 타이머를 건다.
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(mockSession.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
