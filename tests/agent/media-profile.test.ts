import { describe, it, expect } from 'vitest';
import { MediaProfile, mediaContract, validateMediaFormat } from '../../src/agent/media-profile.js';
describe('media profile contracts', () => {
  it.each(['__proto__', 'constructor', 'unknown'])('rejects invalid runtime profile %s', profile => {
    expect(() => mediaContract(profile as MediaProfile)).toThrow('Unsupported');
  });
  it('keeps the legacy 20ms contract and validates the explicit PCM16 format', () => {
    expect(mediaContract(MediaProfile.MULAW_8000)).toEqual({ sampleRate:8000, frameBytes:160, silenceByte:255, encoding:'audio/x-mulaw' });
    const profile = mediaContract(MediaProfile.PCM_S16LE_16000);
    expect(profile.frameBytes).toBe(640);
    expect(() => validateMediaFormat(MediaProfile.PCM_S16LE_16000, { encoding:profile.encoding, sampleRate:16000, channels:1 })).not.toThrow();
    expect(() => validateMediaFormat(MediaProfile.PCM_S16LE_16000, {})).toThrow('does not match');
  });
});
