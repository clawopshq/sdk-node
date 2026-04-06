import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiRealtime } from '../../src/agent/pipeline/realtime/gemini-realtime.js';
import type { Session } from '../../src/agent/pipeline/base.js';

// Mock @google/genai
const mockSession = {
  sendRealtimeInput: vi.fn(),
  sendClientContent: vi.fn(),
  sendToolResponse: vi.fn(),
  close: vi.fn(),
};

const mockConnect = vi.fn().mockResolvedValue(mockSession);

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    live: { connect: mockConnect },
  })),
}));

// Mock CallSession
function createMockCallSession() {
  return {
    callId: 'test-call-id',
    fromNumber: '07012345678',
    toNumber: '07098765432',
    accountId: 'test-account',
    direction: 'inbound' as const,
    startTime: new Date(),
    metadata: {},
    sendAudio: vi.fn(),
    clearAudio: vi.fn(),
    hangup: vi.fn(),
    on: vi.fn(),
    wait: vi.fn(),
    _emit: vi.fn(),
    _bindTransport: vi.fn(),
    _markEnded: vi.fn(),
  };
}

describe('GeminiRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is constructable with no arguments (uses defaults)', () => {
    const session = new GeminiRealtime();
    expect(session).toBeDefined();
  });

  it('implements Session interface', () => {
    const session: Session = new GeminiRealtime();
    expect(session.start).toBeInstanceOf(Function);
    expect(session.stop).toBeInstanceOf(Function);
    expect(session.feedAudio).toBeInstanceOf(Function);
  });

  it('stop resolves without error when not started', async () => {
    const session = new GeminiRealtime();
    await expect(session.stop()).resolves.toBeUndefined();
  });

  describe('start()', () => {
    it('connects via SDK with Stage 1+2 config only', async () => {
      const session = new GeminiRealtime({
        apiKey: 'test-key',
        systemPrompt: 'Test prompt',
        voice: 'Kore',
      });
      const call = createMockCallSession();

      await session.start(call);

      // live.connect() 호출 확인
      expect(mockConnect).toHaveBeenCalledOnce();
      const connectArgs = mockConnect.mock.calls[0][0];

      // model 확인
      expect(connectArgs.model).toBe('gemini-3.1-flash-live-preview');

      // config 확인
      const config = connectArgs.config;
      expect(config.responseModalities).toEqual(['AUDIO']);
      expect(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
      expect(config.systemInstruction).toEqual({ parts: [{ text: 'Test prompt' }] });

      // Stage 2: transcription 포함
      expect(config).toHaveProperty('inputAudioTranscription');
      expect(config).toHaveProperty('outputAudioTranscription');

      // Stage 3: 포함되지 않음
      expect(config).not.toHaveProperty('realtimeInputConfig');
      expect(config).not.toHaveProperty('contextWindowCompression');

      // greeting 전송 확인 (3.1에서는 sendRealtimeInput 사용)
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledOnce();

      await session.stop();
    });

    it('skips greeting when greeting=false', async () => {
      const session = new GeminiRealtime({
        apiKey: 'test-key',
        greeting: false,
      });
      const call = createMockCallSession();

      await session.start(call);

      expect(mockSession.sendClientContent).not.toHaveBeenCalled();

      await session.stop();
    });

    it('omits systemInstruction when systemPrompt is empty', async () => {
      const session = new GeminiRealtime({
        apiKey: 'test-key',
        systemPrompt: '',
      });
      const call = createMockCallSession();

      await session.start(call);

      const config = mockConnect.mock.calls[0][0].config;
      expect(config).not.toHaveProperty('systemInstruction');

      await session.stop();
    });
  });

  describe('feedAudio()', () => {
    it('sends PCM16 16kHz audio via SDK sendRealtimeInput', async () => {
      const session = new GeminiRealtime({ apiKey: 'test-key', greeting: false });
      const call = createMockCallSession();
      await session.start(call);

      // 160 bytes of ulaw silence (0xff)
      const ulawData = Buffer.alloc(160, 0xff);
      session.feedAudio(ulawData);

      // sendRealtimeInput 호출 확인
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledOnce();
      const sendArgs = mockSession.sendRealtimeInput.mock.calls[0][0];
      expect(sendArgs.audio.mimeType).toBe('audio/pcm;rate=16000');

      // SDK Blob.data는 base64 문자열이어야 함
      expect(typeof sendArgs.audio.data).toBe('string');
      // PCM16 16kHz: 160 ulaw → 320B pcm8k → 640B pcm16k → base64(640) = 856 chars
      const decoded = Buffer.from(sendArgs.audio.data, 'base64');
      expect(decoded.length).toBe(640);

      await session.stop();
    });
  });

  describe('stop()', () => {
    it('calls session.close()', async () => {
      const session = new GeminiRealtime({ apiKey: 'test-key' });
      const call = createMockCallSession();
      await session.start(call);

      await session.stop();

      expect(mockSession.close).toHaveBeenCalledOnce();
    });
  });

  describe('_handleMessage()', () => {
    it('emits user transcript from inputTranscription', async () => {
      const session = new GeminiRealtime({ apiKey: 'test-key' });
      const call = createMockCallSession();
      await session.start(call);

      // onmessage 콜백 가져오기
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onmessage({
        serverContent: {
          inputTranscription: { text: '안녕하세요' },
        },
      });

      expect(call._emit).toHaveBeenCalledWith('transcript', 'user', '안녕하세요');

      await session.stop();
    });

    it('emits assistant transcript from outputTranscription', async () => {
      const session = new GeminiRealtime({ apiKey: 'test-key' });
      const call = createMockCallSession();
      await session.start(call);

      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onmessage({
        serverContent: {
          outputTranscription: { text: '반갑습니다' },
        },
      });

      expect(call._emit).toHaveBeenCalledWith('transcript', 'assistant', '반갑습니다');

      await session.stop();
    });

    it('calls clearAudio on barge-in (interrupted)', async () => {
      const session = new GeminiRealtime({ apiKey: 'test-key' });
      const call = createMockCallSession();
      await session.start(call);

      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onmessage({
        serverContent: {
          interrupted: true,
        },
      });

      expect(call.clearAudio).toHaveBeenCalledOnce();

      await session.stop();
    });

    it('calls hangup on hang_up tool call', async () => {
      const session = new GeminiRealtime({ apiKey: 'test-key' });
      const call = createMockCallSession();
      await session.start(call);

      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onmessage({
        toolCall: {
          functionCalls: [{ name: 'hang_up', id: 'tc1', args: {} }],
        },
      });

      // hang_up은 _scheduleToolExecution의 300ms debounce를 거침
      await new Promise((r) => setTimeout(r, 400));

      expect(call.hangup).toHaveBeenCalledOnce();
      // hang_up은 toolResponse를 보내지 않음
      expect(mockSession.sendToolResponse).not.toHaveBeenCalled();

      await session.stop();
    });
  });
});
