import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GeminiRealtime } from '../../src/agent/pipeline/realtime/gemini-realtime.js';
import { BufferingCall } from '../../src/agent/pipeline/buffering-call.js';

const mockSession = {
  sendRealtimeInput: vi.fn(),
  sendClientContent: vi.fn(),
  sendToolResponse: vi.fn(),
  close: vi.fn(),
};

const mockConnect = vi.fn().mockResolvedValue(mockSession);

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
