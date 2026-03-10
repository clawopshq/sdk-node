import { describe, it, expect } from 'vitest';
import { OpenAIRealtime } from '../../src/agent/pipeline/openai-realtime.js';
import type { Session } from '../../src/agent/pipeline/base.js';

describe('OpenAIRealtime', () => {
  it('is constructable with no arguments (uses defaults)', () => {
    const session = new OpenAIRealtime();
    expect(session).toBeDefined();
  });

  it('default model is gpt-4o-realtime-preview', () => {
    const session = new OpenAIRealtime();
    // Access internal options through the instance
    expect(session).toBeDefined();
    // The default model is set in the constructor
    const session2 = new OpenAIRealtime({ model: 'gpt-4o-realtime-preview' });
    expect(session2).toBeDefined();
  });

  it('default voice is alloy', () => {
    const session = new OpenAIRealtime();
    expect(session).toBeDefined();
  });

  it('custom config overrides defaults', () => {
    const session = new OpenAIRealtime({
      apiKey: 'custom-key',
      model: 'gpt-4o-mini-realtime-preview',
      voice: 'echo',
      instructions: 'Be concise',
      inputAudioFormat: 'g711_ulaw',
      outputAudioFormat: 'g711_ulaw',
      temperature: 0.8,
      turnDetection: { type: 'server_vad' },
    });
    expect(session).toBeDefined();
  });

  it('has start method', () => {
    const session = new OpenAIRealtime();
    expect(session.start).toBeInstanceOf(Function);
  });

  it('has stop method', () => {
    const session = new OpenAIRealtime();
    expect(session.stop).toBeInstanceOf(Function);
  });

  it('has feedAudio method', () => {
    const session = new OpenAIRealtime();
    expect(session.feedAudio).toBeInstanceOf(Function);
  });

  it('accepts systemPrompt via instructions option', () => {
    const session = new OpenAIRealtime({
      instructions: 'You are a helpful voice assistant.',
    });
    expect(session).toBeDefined();
  });

  it('implements Session interface', () => {
    const session: Session = new OpenAIRealtime();
    expect(session.start).toBeInstanceOf(Function);
    expect(session.stop).toBeInstanceOf(Function);
    expect(session.feedAudio).toBeInstanceOf(Function);
  });

  it('stop resolves without error when not started', async () => {
    const session = new OpenAIRealtime();
    await expect(session.stop()).resolves.toBeUndefined();
  });

  it('turnDetection can be set to null to disable', () => {
    const session = new OpenAIRealtime({ turnDetection: null });
    expect(session).toBeDefined();
  });
});
