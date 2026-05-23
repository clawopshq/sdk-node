import { describe, it, expect, vi } from 'vitest';

import { PipelineSession } from '../../src/agent/pipeline/pipeline-session.js';
import { BufferingCall } from '../../src/agent/pipeline/buffering-call.js';
import type { STT, LLM, TTS, SpeechEvent, LLMChunk } from '../../src/agent/pipeline/base.js';

function createMockSTT(): STT {
  return {
    async *transcribe(): AsyncGenerator<SpeechEvent> {
      // no events — loop simply waits
    },
  };
}
function createMockLLM(): LLM {
  return {
    async *generate(): AsyncGenerator<LLMChunk> {
      yield { type: 'done' };
    },
  };
}
function createMockTTS(): TTS {
  return {
    async *synthesize(): AsyncGenerator<Buffer> {
      // no chunks
    },
  };
}

describe('PipelineSession prewarm/attach', () => {
  it('prewarm installs BufferingCall without a real CallSession', async () => {
    const sess = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
      systemPrompt: 'x',
      greeting: false,
    });
    await sess.prewarm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sess as any)._callSession).toBeInstanceOf(BufferingCall);
    await sess.stop();
  });

  it('attach replaces BufferingCall and flushes buffered audio', async () => {
    const sess = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
      systemPrompt: 'x',
      greeting: false,
    });
    await sess.prewarm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bc = (sess as any)._callSession as BufferingCall;
    await bc.sendAudio(Buffer.from('u'));

    const sendAudio = vi.fn();
    const realCall = {
      sendAudio,
      _emit: vi.fn(),
      clearAudio: vi.fn(),
      metrics: { recordToolCall: vi.fn() },
      recordToolCall: vi.fn(),
    } as never;
    await sess.attach(realCall);
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from('u'));
    await sess.stop();
  });

  it('start = prewarm + attach', async () => {
    const sess = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
      systemPrompt: 'x',
      greeting: false,
    });
    const prewarmSpy = vi.spyOn(sess, 'prewarm');
    const attachSpy = vi.spyOn(sess, 'attach');
    const realCall = {
      sendAudio: vi.fn(),
      _emit: vi.fn(),
      clearAudio: vi.fn(),
      metrics: { recordToolCall: vi.fn() },
      recordToolCall: vi.fn(),
    } as never;
    await sess.start(realCall);
    expect(prewarmSpy).toHaveBeenCalledOnce();
    expect(attachSpy).toHaveBeenCalledOnce();
    expect(attachSpy).toHaveBeenCalledWith(realCall);
    await sess.stop();
  });
});
