import { describe, it, expect } from 'vitest';
import type { Session, STT, LLM, TTS, SpeechEvent, LLMChunk } from '../../src/agent/pipeline/base.js';
import { OpenAIRealtime } from '../../src/agent/pipeline/openai-realtime.js';
import { GeminiRealtime } from '../../src/agent/pipeline/gemini-realtime.js';
import { PipelineSession } from '../../src/agent/pipeline/pipeline-session.js';

function createMockSTT(): STT {
  return {
    async *transcribe(): AsyncGenerator<SpeechEvent> {},
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
    async *synthesize(): AsyncGenerator<Buffer> {},
  };
}

describe('Session protocol compliance', () => {
  const sessionFactories: Array<{ name: string; create: () => Session }> = [
    {
      name: 'OpenAIRealtime',
      create: () => new OpenAIRealtime(),
    },
    {
      name: 'GeminiRealtime',
      create: () => new GeminiRealtime(),
    },
    {
      name: 'PipelineSession',
      create: () =>
        new PipelineSession({
          stt: createMockSTT(),
          llm: createMockLLM(),
          tts: createMockTTS(),
        }),
    },
  ];

  describe.each(sessionFactories)('$name', ({ create }) => {
    it('has start method', () => {
      const session = create();
      expect(session.start).toBeInstanceOf(Function);
    });

    it('has stop method', () => {
      const session = create();
      expect(session.stop).toBeInstanceOf(Function);
    });

    it('has feedAudio method', () => {
      const session = create();
      expect(session.feedAudio).toBeInstanceOf(Function);
    });

    it('satisfies the Session interface type', () => {
      const session: Session = create();
      expect(session).toBeDefined();
      expect(typeof session.start).toBe('function');
      expect(typeof session.stop).toBe('function');
      expect(typeof session.feedAudio).toBe('function');
    });

    it('stop resolves without error when not started', async () => {
      const session = create();
      await expect(session.stop()).resolves.toBeUndefined();
    });
  });
});
