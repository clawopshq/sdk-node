import { describe, it, expect, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

// 가짜 @livekit/rtc-node (io.ts 의 AudioFrame 용).
vi.mock('@livekit/rtc-node', () => {
  class AudioFrame {
    constructor(
      public data: Int16Array,
      public sampleRate: number,
      public channels: number,
      public samplesPerChannel: number,
    ) {}
  }
  return { AudioFrame };
});

// 가짜 @livekit/agents — voice.AudioOutput(io.ts 상속용) + llm(tool 헬퍼).
vi.mock('@livekit/agents', () => {
  class AudioOutput {
    constructor(
      public sampleRate?: number,
      _n?: unknown,
      _c?: unknown,
    ) {}
    async captureFrame(_f: unknown): Promise<void> {}
    flush(): void {}
    onPlaybackStarted(_t: number): void {}
    onPlaybackFinished(_o: unknown): void {}
    clearBuffer(): void {}
  }
  return {
    voice: { AudioOutput },
    initializeLogger: () => {},
    loggerOptions: () => ({}),
    llm: {
      ToolFlag: { IGNORE_ON_ENTER: 1 },
      tool: (def: any) => ({ ...def }),
      Toolset: { create: (opts: any) => ({ id: opts.id, tools: opts.tools, __toolset: true }) },
      // 실제 agents-js 는 [name, tool] 쌍 배열을 준다 (bare tool 아님).
      sortedToolEntries: (_ctx: any) => [['user_tool', { name: 'user_tool', __tool: true }]],
      sortedToolNames: (_ctx: any) => ['user_tool'],
    },
  };
});

import { LiveKitSession } from '../../src/agent/livekit/session.js';

/** 유저의 AgentSession/Agent 를 흉내내는 가짜 팩토리를 만든다. */
function fakeCreate(opts?: { llm?: any; tts?: any }) {
  const handlers: Record<string, (ev: any) => void> = {};
  const session: any = {
    llm: opts?.llm,
    tts: opts?.tts,
    input: {},
    output: {},
    on: vi.fn((ev: string, cb: (ev: any) => void) => {
      handlers[ev] = cb;
    }),
    start: vi.fn(async () => {}),
    generateReply: vi.fn(),
    aclose: vi.fn(async () => {}),
  };
  const agent: any = { toolCtx: {}, updateTools: vi.fn(async () => {}) };
  const create = vi.fn(async (_call: any) => [session, agent]);
  return { create, session, agent, handlers };
}

function fakeCall() {
  return { callId: 'C1', _emit: vi.fn(), clearAudio: vi.fn(), sendAudio: vi.fn() } as any;
}

describe('LiveKitSession boot', () => {
  it('start → 커스텀 IO 를 세션에 물리고 transcription 은 null, room 없이 start', async () => {
    const { create, session, agent } = fakeCreate();
    const sess = new LiveKitSession(create as any);

    await sess.start(fakeCall());

    expect(session.input.audio).toBeTruthy();
    expect(session.output.audio).toBeTruthy();
    expect(session.output.transcription).toBeNull();
    // room 을 넘기지 않고 start({ agent }) 를 부른다.
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.start.mock.calls[0][0]).toEqual({ agent });

    // updateTools 는 bare tool 배열을 받아야 한다 — sortedToolEntries 의 [name, tool]
    // 쌍을 그대로 펼치면 안 된다 (유저 도구 유실 회귀 방지).
    expect(agent.updateTools).toHaveBeenCalledTimes(1);
    const passed = agent.updateTools.mock.calls[0][0];
    expect(Array.isArray(passed)).toBe(true);
    expect(passed.every((t: any) => !Array.isArray(t))).toBe(true); // 쌍 아님
    expect(passed).toContainEqual({ name: 'user_tool', __tool: true }); // bare tool 로 추출됨
  });
});

describe('LiveKitSession transcript 브리지', () => {
  it('conversation_item_added(user/assistant) → call._emit(transcript)', async () => {
    const { create, handlers } = fakeCreate();
    const sess = new LiveKitSession(create as any);
    const call = fakeCall();
    await sess.start(call);

    handlers['conversation_item_added']!({ item: { role: 'user', textContent: '안녕하세요' } });
    expect(call._emit).toHaveBeenCalledWith('transcript', 'user', '안녕하세요');

    handlers['conversation_item_added']!({ item: { role: 'assistant', textContent: '네' } });
    expect(call._emit).toHaveBeenCalledWith('transcript', 'assistant', '네');
  });

  it('handoff 등 role 없는 item / 빈 텍스트는 무시한다', async () => {
    const { create, handlers } = fakeCreate();
    const sess = new LiveKitSession(create as any);
    const call = fakeCall();
    await sess.start(call);

    handlers['conversation_item_added']!({ item: {} }); // role 없음 (handoff)
    handlers['conversation_item_added']!({ item: { role: 'user', textContent: '' } }); // 빈 텍스트
    expect(call._emit).not.toHaveBeenCalled();
  });
});

describe('LiveKitSession _validate', () => {
  it("realtime modalities=['text'] 인데 tts 없으면 시작 시 에러", async () => {
    // llm.capabilities.audioOutput === false + tts 없음
    const { create } = fakeCreate({ llm: { capabilities: { audioOutput: false } } });
    const sess = new LiveKitSession(create as any);
    await expect(sess.start(fakeCall())).rejects.toThrow(/소리를/);
  });

  it('realtime audio(capabilities.audioOutput=true) 는 통과한다', async () => {
    const { create, session } = fakeCreate({ llm: { capabilities: { audioOutput: true } } });
    const sess = new LiveKitSession(create as any);
    await sess.start(fakeCall());
    expect(session.start).toHaveBeenCalled();
  });
});
