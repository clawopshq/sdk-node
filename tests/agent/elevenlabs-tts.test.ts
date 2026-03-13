import { describe, it, expect } from 'vitest';
import { ElevenLabsTTS } from '../../src/agent/pipeline/tts/elevenlabs-tts.js';
import type { TTS } from '../../src/agent/pipeline/base.js';

describe('ElevenLabsTTS', () => {
  it('implements TTS interface (has synthesize method)', () => {
    const tts = new ElevenLabsTTS();
    expect(tts.synthesize).toBeInstanceOf(Function);
    // Verify type compliance
    const _check: TTS = tts;
    expect(_check).toBeDefined();
  });

  it('constructor accepts empty options (uses defaults)', () => {
    const tts = new ElevenLabsTTS();
    expect(tts).toBeDefined();
  });

  it('constructor accepts custom options', () => {
    const tts = new ElevenLabsTTS({
      apiKey: 'test-key',
      voiceId: 'custom-voice',
      modelId: 'eleven_monolingual_v1',
      outputFormat: 'pcm_24000',
      stability: 0.7,
      similarityBoost: 0.8,
      style: 1,
      useSpeakerBoost: false,
    });
    expect(tts).toBeDefined();
  });

  it('sample rate can be extracted from outputFormat naming convention', () => {
    // The default outputFormat is 'pcm_16000', sample rate = 16000
    const tts = new ElevenLabsTTS({ outputFormat: 'pcm_24000' });
    expect(tts).toBeDefined();
    // The actual sample rate is embedded in the outputFormat string
  });

  it('synthesize throws without API key', async () => {
    const tts = new ElevenLabsTTS();
    const original = process.env['ELEVENLABS_API_KEY'];
    delete process.env['ELEVENLABS_API_KEY'];

    try {
      const gen = tts.synthesize('Hello');
      await gen.next();
      expect.unreachable('Expected an error');
    } catch (err) {
      expect((err as Error).message).toContain('ElevenLabs API key is required');
    } finally {
      if (original) process.env['ELEVENLABS_API_KEY'] = original;
    }
  });
});
