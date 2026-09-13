import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OpenAIRealtime } from '../../src/agent/pipeline/realtime/openai-realtime.js';

// transcriptionPrompt 가 전사 설정에 실리는지 — 설정값 저장이 아니라 실제로 보낸 session.update 를 본다.
type Handler = (...args: unknown[]) => void;
let mockInstances: MockWs[] = [];

class MockWs {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 1;
  sent: string[] = [];
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
    for (const fn of this._handlers.get('close') ?? []) fn();
  }
}

vi.mock('ws', () => ({ WebSocket: MockWs }));

async function sentTranscription(sess: OpenAIRealtime): Promise<Record<string, unknown>> {
  await sess.prewarm();
  const update = mockInstances[0]!.sent
    .map((s) => JSON.parse(s) as Record<string, any>) // eslint-disable-line @typescript-eslint/no-explicit-any
    .find((m) => m['type'] === 'session.update' && m['session']?.audio);
  return update!['session'].audio.input.transcription as Record<string, unknown>;
}

describe('OpenAIRealtime transcriptionPrompt', () => {
  beforeEach(() => {
    mockInstances = [];
  });

  it('보내는 전사 설정에 prompt 가 실린다', async () => {
    const sess = new OpenAIRealtime({
      apiKey: 'sk-test',
      greeting: false,
      transcriptionPrompt: '재진, 초진, 직원 연결',
    });
    const transcription = await sentTranscription(sess);
    expect(transcription['prompt']).toBe('재진, 초진, 직원 연결');
    // 기존 키는 그대로
    expect(transcription['model']).toBe('gpt-4o-transcribe');
    expect(transcription['language']).toBe('ko');
  });

  it.each([undefined, ''])('값이 %j 이면 prompt 키를 보내지 않는다', async (prompt) => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false, transcriptionPrompt: prompt });
    const transcription = await sentTranscription(sess);
    expect(transcription).not.toHaveProperty('prompt');
  });
});
