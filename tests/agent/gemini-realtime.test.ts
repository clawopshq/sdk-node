import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GeminiRealtime,
  defaultToolBehavior,
} from '../../src/agent/pipeline/realtime/gemini-realtime.js';
import { ToolRegistry } from '../../src/agent/tool.js';
import type { Session } from '../../src/agent/pipeline/base.js';

// Mock @google/genai
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
    recordToolCall: vi.fn(),
    recordToolError: vi.fn(),
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
      expect(config).not.toHaveProperty('thinkingConfig');
      expect(config).not.toHaveProperty('proactivity');

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

    it('passes thinkingConfig through as-is', async () => {
      // gemini-3.8-live-extended-thinking 은 thinkingLevel 이 없으면 연결을 거절한다.
      const thinkingConfig = { thinkingLevel: 'LOW' };
      const session = new GeminiRealtime({
        apiKey: 'test-key',
        model: 'gemini-3.8-live-extended-thinking',
        thinkingConfig,
      });
      const call = createMockCallSession();

      await session.start(call);

      const connectArgs = mockConnect.mock.calls[0][0];
      expect(connectArgs.model).toBe('gemini-3.8-live-extended-thinking');
      expect(connectArgs.config.thinkingConfig).toEqual(thinkingConfig);

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

      // hang_up은 _scheduleToolExecution의 300ms debounce를 거침 (CI 환경 고려하여 여유 확보)
      await new Promise((r) => setTimeout(r, 800));

      expect(call.hangup).toHaveBeenCalledOnce();
      // hang_up은 toolResponse를 보내지 않음
      expect(mockSession.sendToolResponse).not.toHaveBeenCalled();

      await session.stop();
    });
  });

  // ── 3.8 Live 함수 호출 behavior · proactive audio · apiVersion (0.48.0) ──────────
  describe('tool behavior (Gemini 3.8 Live)', () => {
    it.each([
      ['gemini-3.8-live', 'BLOCKING'],
      ['models/gemini-3.8-live', 'BLOCKING'],
      ['gemini-3.8-live-extended-thinking', 'NON_BLOCKING'],
      ['gemini-3.1-flash-live-preview', null],
      ['gemini-2.5-flash-native-audio-preview-12-2025', null],
    ])('defaultToolBehavior(%s) → %s', (model, expected) => {
      // 3.8-live 는 서버 기본값이 NON_BLOCKING 이라 BLOCKING 을 명시하고, ET 는 NON_BLOCKING 만 받는다.
      expect(defaultToolBehavior(model)).toBe(expected);
    });

    it('declares every tool BLOCKING on gemini-3.8-live (custom + builtin)', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      const tools = new ToolRegistry();
      tools.register({
        name: 'lookup_order',
        description: '주문 조회',
        parameters: { order_id: { type: 'string' } },
        required: ['order_id'],
        handler: async () => 'ok',
      });
      session.setToolRegistry(tools);
      await session.start(createMockCallSession());

      const decls = mockConnect.mock.calls[0][0].config.tools[0].functionDeclarations as Array<
        Record<string, unknown>
      >;
      const names = decls.map((d) => d['name']);
      expect(names).toEqual(expect.arrayContaining(['lookup_order', 'hang_up']));
      // 커스텀·내장 가리지 않고 전부 BLOCKING — 내장 도구(hang_up 등)를 모델이 말로 덮지 않게.
      expect(decls.every((d) => d['behavior'] === 'BLOCKING')).toBe(true);
      await session.stop();
    });

    it('omits behavior when the model has no default (3.1)', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.1-flash-live-preview',
        greeting: false,
      });
      await session.start(createMockCallSession());
      const decls = mockConnect.mock.calls[0][0].config.tools[0].functionDeclarations as Array<
        Record<string, unknown>
      >;
      expect(decls.every((d) => !('behavior' in d))).toBe(true);
      await session.stop();
    });

    it('declares NON_BLOCKING on extended-thinking', () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live-extended-thinking',
      });
      expect(session.effectiveToolBehavior()).toBe('NON_BLOCKING');
    });

    it('explicit toolBehavior overrides the model default', () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        toolBehavior: 'NON_BLOCKING',
      });
      expect(session.effectiveToolBehavior()).toBe('NON_BLOCKING');
    });

    it('rejects an unknown toolBehavior', () => {
      expect(
        () => new GeminiRealtime({ apiKey: 'k', toolBehavior: 'ASYNC' as unknown as 'BLOCKING' }),
      ).toThrow(/toolBehavior/);
    });
  });

  describe('proactiveAudio / apiVersion', () => {
    it('passes proactiveAudio through as proactivity.proactiveAudio', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        proactiveAudio: true,
        greeting: false,
      });
      await session.start(createMockCallSession());
      expect(mockConnect.mock.calls[0][0].config.proactivity).toEqual({ proactiveAudio: true });
      await session.stop();
    });

    it('passes apiVersion to GoogleGenAI httpOptions', async () => {
      const { GoogleGenAI } = await import('@google/genai');
      const ctor = GoogleGenAI as unknown as ReturnType<typeof vi.fn>;
      const session = new GeminiRealtime({ apiKey: 'k', apiVersion: 'v1alpha', greeting: false });
      await session.start(createMockCallSession());
      expect(ctor).toHaveBeenLastCalledWith({
        apiKey: 'k',
        httpOptions: { apiVersion: 'v1alpha' },
      });
      await session.stop();
    });

    it('does not set httpOptions when apiVersion is omitted', async () => {
      const { GoogleGenAI } = await import('@google/genai');
      const ctor = GoogleGenAI as unknown as ReturnType<typeof vi.fn>;
      const session = new GeminiRealtime({ apiKey: 'k', greeting: false });
      await session.start(createMockCallSession());
      expect(ctor).toHaveBeenLastCalledWith({ apiKey: 'k' });
      await session.stop();
    });
  });

  // ── 도구별 behavior/scheduling + NON_BLOCKING 런타임 (0.49.0) ─────────────────
  describe('per-tool behavior / NON_BLOCKING runtime', () => {
    function registryWith(
      ...tools: Array<{
        name: string;
        handler: () => unknown;
        behavior?: 'BLOCKING' | 'NON_BLOCKING';
        scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT';
      }>
    ): ToolRegistry {
      const reg = new ToolRegistry();
      for (const t of tools) {
        reg.register({
          name: t.name,
          description: t.name,
          parameters: { x: { type: 'string' } },
          required: ['x'],
          handler: t.handler,
          ...(t.behavior ? { behavior: t.behavior } : {}),
          ...(t.scheduling ? { scheduling: t.scheduling } : {}),
        });
      }
      return reg;
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const decls = () =>
      mockConnect.mock.calls[0][0].config.tools[0].functionDeclarations as Array<
        Record<string, unknown>
      >;

    it('registry validates behavior/scheduling and keeps them out of OpenAI schemas', () => {
      const reg = registryWith({
        name: 'a',
        handler: () => 'r',
        behavior: 'NON_BLOCKING',
        scheduling: 'INTERRUPT',
      });
      expect(reg.get('a')?.behavior).toBe('NON_BLOCKING');
      expect(reg.toOpenAITools()[0]).not.toHaveProperty('behavior');
      expect(() =>
        reg.register({
          name: 'bad',
          description: '',
          parameters: {},
          required: [],
          handler: () => 'r',
          behavior: 'ASYNC' as unknown as 'BLOCKING',
        }),
      ).toThrow(/behavior/);
    });

    it('per-tool behavior overrides the session default; builtin stays BLOCKING', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      session.setToolRegistry(
        registryWith(
          {
            name: 'save_note',
            handler: () => 'saved',
            behavior: 'NON_BLOCKING',
            scheduling: 'WHEN_IDLE',
          },
          { name: 'lookup', handler: () => 'ok' },
        ),
      );
      await session.start(createMockCallSession());
      const byName = Object.fromEntries(decls().map((d) => [d['name'], d]));
      expect(byName['save_note']!['behavior']).toBe('NON_BLOCKING');
      expect(byName['lookup']!['behavior']).toBe('BLOCKING');
      expect(byName['hang_up']!['behavior']).toBe('BLOCKING');
      await session.stop();
    });

    it('session toolBehavior=NON_BLOCKING still declares builtin tools BLOCKING', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        toolBehavior: 'NON_BLOCKING',
        greeting: false,
      });
      session.setToolRegistry(registryWith({ name: 'lookup', handler: () => 'ok' }));
      await session.start(createMockCallSession());
      const byName = Object.fromEntries(decls().map((d) => [d['name'], d]));
      expect(byName['lookup']!['behavior']).toBe('NON_BLOCKING');
      expect(byName['hang_up']!['behavior']).toBe('BLOCKING');
      await session.stop();
    });

    it('extended-thinking forces NON_BLOCKING even when a tool asks BLOCKING', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live-extended-thinking',
        greeting: false,
      });
      session.setToolRegistry(
        registryWith({ name: 'lookup', handler: () => 'ok', behavior: 'BLOCKING' }),
      );
      await session.start(createMockCallSession());
      expect(decls().every((d) => d['behavior'] === 'NON_BLOCKING')).toBe(true);
      await session.stop();
    });

    it('rejects an unknown toolResponseScheduling', () => {
      expect(
        () =>
          new GeminiRealtime({
            apiKey: 'k',
            toolResponseScheduling: 'LATER' as unknown as 'SILENT',
          }),
      ).toThrow(/toolResponseScheduling/);
    });

    it('runs a NON_BLOCKING tool immediately (no 300ms drain), keeps receiving, replies when done', async () => {
      let release!: () => void;
      const gate = new Promise<string>((r) => (release = () => r('done')));
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      session.setToolRegistry(
        registryWith({ name: 'slow', handler: () => gate, behavior: 'NON_BLOCKING' }),
      );
      const call = createMockCallSession();
      await session.start(call);
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onmessage({ toolCall: { functionCalls: [{ name: 'slow', id: 'c1', args: { x: '1' } }] } });
      await tick();
      // 도구가 도는 동안 수신 경로는 살아 있다.
      onmessage({ serverContent: { outputTranscription: { text: '잠시만요' } } });
      expect(call._emit).toHaveBeenCalledWith('transcript', 'assistant', '잠시만요');
      expect(mockSession.sendToolResponse).not.toHaveBeenCalled();

      release();
      await tick();
      // drain 300ms 를 기다리지 않았다.
      expect(mockSession.sendToolResponse).toHaveBeenCalledOnce();
      const [resp] = mockSession.sendToolResponse.mock.calls[0][0].functionResponses;
      expect(resp).toEqual({ id: 'c1', name: 'slow', response: { result: 'done' } });
      await session.stop();
    });

    it('sends SILENT when a NON_BLOCKING tool returns nothing', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      session.setToolRegistry(
        registryWith({ name: 'note', handler: () => undefined, behavior: 'NON_BLOCKING' }),
      );
      await session.start(createMockCallSession());
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;
      onmessage({ toolCall: { functionCalls: [{ name: 'note', id: 'c2', args: { x: '1' } }] } });
      await tick();
      const [resp] = mockSession.sendToolResponse.mock.calls[0][0].functionResponses;
      expect(resp).toEqual({
        id: 'c2',
        name: 'note',
        response: { result: 'ok' },
        scheduling: 'SILENT',
      });
      await session.stop();
    });

    it('scheduling precedence: tool > session > server default', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        toolResponseScheduling: 'WHEN_IDLE',
        greeting: false,
      });
      session.setToolRegistry(
        registryWith(
          { name: 'urgent', handler: () => 'r', behavior: 'NON_BLOCKING', scheduling: 'INTERRUPT' },
          { name: 'normal', handler: () => 'r', behavior: 'NON_BLOCKING' },
        ),
      );
      await session.start(createMockCallSession());
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;
      onmessage({
        toolCall: {
          functionCalls: [
            { name: 'urgent', id: 'u', args: { x: '1' } },
            { name: 'normal', id: 'n', args: { x: '1' } },
          ],
        },
      });
      await tick();
      const sent = Object.fromEntries(
        mockSession.sendToolResponse.mock.calls.flatMap((c) =>
          (c[0].functionResponses as Array<Record<string, unknown>>).map((r) => [
            r['name'],
            r['scheduling'],
          ]),
        ),
      );
      expect(sent).toEqual({ urgent: 'INTERRUPT', normal: 'WHEN_IDLE' });
      await session.stop();
    });

    it('never sends scheduling on extended-thinking', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live-extended-thinking',
        toolResponseScheduling: 'SILENT',
        greeting: false,
      });
      session.setToolRegistry(registryWith({ name: 'note', handler: () => undefined }));
      await session.start(createMockCallSession());
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;
      onmessage({ toolCall: { functionCalls: [{ name: 'note', id: 'e1', args: { x: '1' } }] } });
      await tick();
      const [resp] = mockSession.sendToolResponse.mock.calls[0][0].functionResponses;
      expect(resp).not.toHaveProperty('scheduling');
      await session.stop();
    });

    it('drops the result of a cancelled NON_BLOCKING call', async () => {
      let release!: () => void;
      const gate = new Promise<string>((r) => (release = () => r('done')));
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      session.setToolRegistry(
        registryWith({ name: 'slow', handler: () => gate, behavior: 'NON_BLOCKING' }),
      );
      await session.start(createMockCallSession());
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;
      onmessage({ toolCall: { functionCalls: [{ name: 'slow', id: 'c1', args: { x: '1' } }] } });
      await tick();
      onmessage({ toolCallCancellation: { ids: ['c1'] } });
      release();
      await tick();
      expect(mockSession.sendToolResponse).not.toHaveBeenCalled();
      await session.stop();
    });

    it('BLOCKING tools still go through the drain path (not immediate)', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      session.setToolRegistry(registryWith({ name: 'lookup', handler: () => 'ok' }));
      await session.start(createMockCallSession());
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;
      onmessage({ toolCall: { functionCalls: [{ name: 'lookup', id: 'b1', args: { x: '1' } }] } });
      await tick();
      expect(mockSession.sendToolResponse).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 800));
      expect(mockSession.sendToolResponse).toHaveBeenCalledOnce();
      await session.stop();
    });

    it('omits id when the server sent none', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      session.setToolRegistry(
        registryWith({ name: 'note', handler: () => 'saved', behavior: 'NON_BLOCKING' }),
      );
      await session.start(createMockCallSession());
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;
      onmessage({ toolCall: { functionCalls: [{ name: 'note', args: { x: '1' } }] } });
      await tick();
      const [resp] = mockSession.sendToolResponse.mock.calls[0][0].functionResponses;
      expect(resp).not.toHaveProperty('id');
      await session.stop();
    });

    it('flushes the audio remainder on generationComplete', async () => {
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      const call = createMockCallSession();
      await session.start(call);
      const onmessage = mockConnect.mock.calls[0][0].callbacks.onmessage;
      // 60B PCM16@24k = 30 samples → 10 samples@8k → 10B ulaw: 160B 프레임을 못 채워 잔여로 남는다.
      const pcm = Buffer.alloc(60, 0x10).toString('base64');
      onmessage({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: pcm } }] },
        },
      });
      expect(call.sendAudio).not.toHaveBeenCalled();
      onmessage({ serverContent: { generationComplete: true } });
      expect(call.sendAudio).toHaveBeenCalledOnce();
      expect((call.sendAudio.mock.calls[0][0] as Buffer).length).toBe(160);
      await session.stop();
    });
  });

  // ── 세션 수명: sessionResumption · goAway 재접속 · session_lost (0.50.0) ────────
  describe('session lifetime (goAway / reconnect)', () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    function makeSession() {
      return {
        sendRealtimeInput: vi.fn(),
        sendClientContent: vi.fn(),
        sendToolResponse: vi.fn(),
        close: vi.fn(),
      };
    }
    /** connect 마다 새 세션 객체를 돌려주고 config·callbacks 를 기록한다. */
    function connectSequence(sessions: Array<ReturnType<typeof makeSession> | Error>) {
      const seen: Array<{
        config: Record<string, unknown>;
        callbacks: Record<string, (x: unknown) => void>;
      }> = [];
      let i = 0;
      mockConnect.mockImplementation(async ({ config, callbacks }) => {
        const next = sessions[Math.min(i++, sessions.length - 1)]!;
        seen.push({ config, callbacks });
        if (next instanceof Error) throw next;
        queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
        return next;
      });
      return seen;
    }

    it('sends sessionResumption on every connect and passes contextWindowCompression through', async () => {
      const seen = connectSequence([makeSession()]);
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
        contextWindowCompression: { slidingWindow: {} },
      });
      await session.start(createMockCallSession());
      expect(seen[0]!.config['sessionResumption']).toEqual({});
      expect(seen[0]!.config['contextWindowCompression']).toEqual({ slidingWindow: {} });
      await session.stop();
    });

    it('omits sessionResumption when disabled', async () => {
      const seen = connectSequence([makeSession()]);
      const session = new GeminiRealtime({
        apiKey: 'k',
        greeting: false,
        sessionResumption: false,
      });
      await session.start(createMockCallSession());
      expect(seen[0]!.config).not.toHaveProperty('sessionResumption');
      expect(seen[0]!.config).not.toHaveProperty('contextWindowCompression');
      await session.stop();
    });

    it('stores the resumption handle and reconnects with it on goAway', async () => {
      const s1 = makeSession();
      const s2 = makeSession();
      const seen = connectSequence([s1, s2]);
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      const call = createMockCallSession();
      await session.start(call);
      const onmessage = seen[0]!.callbacks.onmessage;

      onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'h-123' } });
      onmessage({ goAway: { timeLeft: '10s' } });
      await tick();
      await tick();

      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(seen[1]!.config['sessionResumption']).toEqual({ handle: 'h-123' });
      expect(s1.close).toHaveBeenCalledOnce();
      // 이후 입력은 새 연결로 간다.
      session.feedAudio(Buffer.alloc(160, 0xff));
      expect(s2.sendRealtimeInput).toHaveBeenCalledOnce();
      expect(s1.sendRealtimeInput).not.toHaveBeenCalled();
      expect(call.hangup).not.toHaveBeenCalled();
      await session.stop();
    });

    it('reconnects when the connection closes mid-call', async () => {
      const s1 = makeSession();
      const s2 = makeSession();
      const seen = connectSequence([s1, s2]);
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      await session.start(createMockCallSession());

      seen[0]!.callbacks.onclose({ code: 1011, reason: 'going away' });
      await tick();
      await tick();
      expect(mockConnect).toHaveBeenCalledTimes(2);
      session.feedAudio(Buffer.alloc(160, 0xff));
      expect(s2.sendRealtimeInput).toHaveBeenCalledOnce();
      await session.stop();
    });

    it('emits session_lost and hangs up when reconnect keeps failing (handle + fresh)', async () => {
      const s1 = makeSession();
      const seen = connectSequence([s1, new Error('boom')]);
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
        reconnectMaxAttempts: 1,
      });
      const call = createMockCallSession();
      await session.start(call);

      seen[0]!.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'h-1' },
      });
      seen[0]!.callbacks.onmessage({ goAway: { timeLeft: '1s' } });
      await new Promise((r) => setTimeout(r, 200));
      // 핸들 시도 1회 + 핸들 없는 새 세션 시도 1회
      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(s1.close).toHaveBeenCalledOnce(); // 옛 연결은 재접속 전에 닫는다
      expect(call._emit).toHaveBeenCalledWith(
        'session_lost',
        expect.stringContaining('reconnect failed'),
      );
      expect(call.hangup).toHaveBeenCalledOnce();
      await session.stop();
    });

    it('falls back to a fresh session when resuming with the handle is rejected', async () => {
      const s1 = makeSession();
      const fresh = makeSession();
      const seen: Array<{
        config: Record<string, unknown>;
        callbacks: Record<string, (x: unknown) => void>;
      }> = [];
      mockConnect.mockImplementation(async ({ config, callbacks }) => {
        seen.push({ config, callbacks });
        const resumption = config['sessionResumption'] as { handle?: string } | undefined;
        if (seen.length === 1) {
          queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
          return s1;
        }
        if (resumption?.handle)
          throw new Error('1008 session is already connected to an existing client');
        queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
        return fresh;
      });
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
        reconnectMaxAttempts: 1,
      });
      const call = createMockCallSession();
      await session.start(call);
      seen[0]!.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'h-1' },
      });
      seen[0]!.callbacks.onmessage({ goAway: { timeLeft: '1s' } });
      await new Promise((r) => setTimeout(r, 100));
      expect(
        seen.map((x) => (x.config['sessionResumption'] as { handle?: string })?.handle ?? null),
      ).toEqual([null, 'h-1', null]);
      session.feedAudio(Buffer.alloc(160, 0xff));
      expect(fresh.sendRealtimeInput).toHaveBeenCalledOnce();
      expect(call.hangup).not.toHaveBeenCalled();
      await session.stop();
    });

    it('ignores control messages from the replaced connection but still passes transcripts', async () => {
      const s1 = makeSession();
      const s2 = makeSession();
      const seen = connectSequence([s1, s2, makeSession()]);
      const session = new GeminiRealtime({
        apiKey: 'k',
        model: 'gemini-3.8-live',
        greeting: false,
      });
      const call = createMockCallSession();
      await session.start(call);
      seen[0]!.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'h-1' },
      });
      seen[0]!.callbacks.onmessage({ goAway: { timeLeft: '10s' } });
      await tick();
      await tick();
      expect(mockConnect).toHaveBeenCalledTimes(2);
      seen[1]!.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'h-2' },
      });

      // 옛 연결(s1)에서 늦게 온 제어 메시지들
      seen[0]!.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'h-stale' },
      });
      seen[0]!.callbacks.onmessage({ goAway: { timeLeft: '1s' } });
      seen[0]!.callbacks.onmessage({
        serverContent: { outputTranscription: { text: '늦은 전사' } },
      });
      await tick();
      await tick();
      expect(mockConnect).toHaveBeenCalledTimes(2); // 재접속을 또 하지 않는다
      expect(call._emit).toHaveBeenCalledWith('transcript', 'assistant', '늦은 전사');
      // 옛 핸들이 새 핸들을 덮지 않았다: 다음 재접속은 h-2 로 간다
      seen[1]!.callbacks.onmessage({ goAway: { timeLeft: '10s' } });
      await tick();
      await tick();
      expect(seen[2]!.config['sessionResumption']).toEqual({ handle: 'h-2' });
      await session.stop();
    });

    it('does not reconnect after stop()', async () => {
      const s1 = makeSession();
      const seen = connectSequence([s1, makeSession()]);
      const session = new GeminiRealtime({ apiKey: 'k', greeting: false });
      await session.start(createMockCallSession());
      await session.stop();
      seen[0]!.callbacks.onclose({ code: 1000 });
      await tick();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });
});
