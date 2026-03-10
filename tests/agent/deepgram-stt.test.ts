import { describe, it, expect } from 'vitest';
import { DeepgramSTT } from '../../src/agent/pipeline/deepgram-stt.js';
import type { STT } from '../../src/agent/pipeline/base.js';

describe('DeepgramSTT', () => {
  it('implements STT interface (has transcribe method)', () => {
    const stt = new DeepgramSTT();
    expect(stt.transcribe).toBeInstanceOf(Function);
    // Verify it satisfies the STT type
    const _check: STT = stt;
    expect(_check).toBeDefined();
  });

  it('constructor accepts empty options (uses defaults)', () => {
    const stt = new DeepgramSTT();
    expect(stt).toBeDefined();
  });

  it('constructor accepts custom options', () => {
    const stt = new DeepgramSTT({
      apiKey: 'test-key',
      model: 'nova-3',
      language: 'en',
      sampleRate: 16000,
      channels: 2,
      encoding: 'opus',
      interimResults: false,
      punctuate: false,
      smartFormat: false,
    });
    expect(stt).toBeDefined();
  });

  it('transcribe throws without API key', async () => {
    const stt = new DeepgramSTT();
    // Ensure env var is not set
    const original = process.env['DEEPGRAM_API_KEY'];
    delete process.env['DEEPGRAM_API_KEY'];

    const fakeStream = (async function* () {
      yield Buffer.from('audio');
    })();

    try {
      const gen = stt.transcribe(fakeStream);
      await gen.next();
      // Should have thrown
      expect.unreachable('Expected an error');
    } catch (err) {
      expect((err as Error).message).toContain('Deepgram API key is required');
    } finally {
      if (original) process.env['DEEPGRAM_API_KEY'] = original;
    }
  });
});
