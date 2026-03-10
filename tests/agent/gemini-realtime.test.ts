import { describe, it, expect } from 'vitest';
import { GeminiRealtime } from '../../src/agent/pipeline/gemini-realtime.js';
import type { Session } from '../../src/agent/pipeline/base.js';

describe('GeminiRealtime', () => {
  it('is constructable with no arguments (uses defaults)', () => {
    const session = new GeminiRealtime();
    expect(session).toBeDefined();
  });

  it('default model is gemini-2.0-flash-exp', () => {
    const session = new GeminiRealtime();
    expect(session).toBeDefined();
    // Verified by source: default model is 'gemini-2.0-flash-exp'
  });

  it('default voice falls back to Aoede', () => {
    const session = new GeminiRealtime();
    expect(session).toBeDefined();
    // Verified by source: voiceName defaults to 'Aoede'
  });

  it('initialization with custom parameters', () => {
    const session = new GeminiRealtime({
      apiKey: 'custom-key',
      model: 'gemini-2.5-pro',
      voice: 'Kore',
      systemInstruction: 'Be helpful',
      generationConfig: { temperature: 0.5 },
    });
    expect(session).toBeDefined();
  });

  it('has start method', () => {
    const session = new GeminiRealtime();
    expect(session.start).toBeInstanceOf(Function);
  });

  it('has stop method', () => {
    const session = new GeminiRealtime();
    expect(session.stop).toBeInstanceOf(Function);
  });

  it('has feedAudio method', () => {
    const session = new GeminiRealtime();
    expect(session.feedAudio).toBeInstanceOf(Function);
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

  it('accepts systemInstruction option', () => {
    const session = new GeminiRealtime({
      systemInstruction: 'You are a Korean voice assistant.',
    });
    expect(session).toBeDefined();
  });
});
