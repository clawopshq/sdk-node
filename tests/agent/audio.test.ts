import { describe, it, expect } from 'vitest';
import {
  ulawToPcm16,
  pcm16ToUlaw,
  resamplePcm16,
  DECODE_TABLE,
} from '../../src/agent/audio.js';

describe('audio codec', () => {
  it('decodes ulaw silence (0xFF) to near-zero PCM16', () => {
    const ulaw = Buffer.alloc(160, 0xff);
    const pcm = ulawToPcm16(ulaw);
    expect(pcm.length).toBe(320);
    const sample = pcm.readInt16LE(0);
    expect(Math.abs(sample)).toBeLessThan(10);
  });

  it('decodes ulaw returning correct length (160 -> 320)', () => {
    const ulaw = Buffer.alloc(160, 0x80);
    const pcm = ulawToPcm16(ulaw);
    expect(pcm.length).toBe(320);
  });

  it('handles empty input', () => {
    const pcm = ulawToPcm16(Buffer.alloc(0));
    expect(pcm.length).toBe(0);
    const ulaw = pcm16ToUlaw(Buffer.alloc(0));
    expect(ulaw.length).toBe(0);
  });

  it('encodes PCM16 silence to ulaw 0xFF', () => {
    const pcm = Buffer.alloc(320, 0);
    const ulaw = pcm16ToUlaw(pcm);
    expect(ulaw.length).toBe(160);
    expect(ulaw[0]).toBe(0xff);
  });

  it('roundtrips ulaw -> PCM16 -> ulaw', () => {
    const original = Buffer.from([0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70]);
    const pcm = ulawToPcm16(original);
    const back = pcm16ToUlaw(pcm);
    for (let i = 0; i < original.length; i++) {
      expect(back[i]).toBe(original[i]);
    }
  });

  it('resamples 8kHz to 16kHz (doubles length)', () => {
    const pcm8k = Buffer.alloc(160 * 2);
    const pcm16k = resamplePcm16(pcm8k, 8000, 16000);
    expect(pcm16k.length).toBe(160 * 2 * 2);
  });

  it('resamples 24kHz to 8kHz (thirds length)', () => {
    const pcm24k = Buffer.alloc(480 * 2);
    const pcm8k = resamplePcm16(pcm24k, 24000, 8000);
    expect(pcm8k.length).toBe(160 * 2);
  });

  it('DECODE_TABLE has 256 entries', () => {
    expect(DECODE_TABLE.length).toBe(256);
  });
});
