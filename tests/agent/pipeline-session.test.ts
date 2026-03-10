import { describe, it, expect } from 'vitest';
import { PipelineSession } from '../../src/agent/pipeline/pipeline-session.js';
import type { STT, LLM, TTS, SpeechEvent, LLMChunk, Session } from '../../src/agent/pipeline/base.js';

function createMockSTT(): STT {
  return {
    async *transcribe(): AsyncGenerator<SpeechEvent> {
      // no-op for unit tests
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
      // no-op
    },
  };
}

describe('PipelineSession', () => {
  it('constructor accepts STT, LLM, TTS', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session).toBeDefined();
  });

  it('implements Session interface', () => {
    const session: Session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.start).toBeInstanceOf(Function);
    expect(session.stop).toBeInstanceOf(Function);
    expect(session.feedAudio).toBeInstanceOf(Function);
  });

  it('has start method that accepts CallSession', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.start).toBeInstanceOf(Function);
    // start signature: (callSession: CallSession, tools?: ToolRegistry) => Promise<void>
  });

  it('has stop method', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.stop).toBeInstanceOf(Function);
  });

  it('has feedAudio method', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.feedAudio).toBeInstanceOf(Function);
  });

  it('accepts optional configuration (systemPrompt, temperature, etc.)', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
      systemPrompt: 'You are a helpful assistant',
      temperature: 0.7,
      maxTokens: 256,
      sampleRate: 16000,
      interruptOnSpeech: false,
    });
    expect(session).toBeDefined();
  });

  it('stop resolves without error', async () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    await expect(session.stop()).resolves.toBeUndefined();
  });
});
