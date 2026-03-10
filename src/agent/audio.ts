/**
 * Audio codec utilities: PCM16 <-> ulaw conversion and resampling.
 */

const _BIAS = 0x84;
const _CLIP = 32635;

// prettier-ignore
const DECODE_TABLE: readonly number[] = [
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364,  -9852,  -9340,  -8828,  -8316,
   -7932,  -7676,  -7420,  -7164,  -6908,  -6652,  -6396,  -6140,
   -5884,  -5628,  -5372,  -5116,  -4860,  -4604,  -4348,  -4092,
   -3900,  -3772,  -3644,  -3516,  -3388,  -3260,  -3132,  -3004,
   -2876,  -2748,  -2620,  -2492,  -2364,  -2236,  -2108,  -1980,
   -1884,  -1820,  -1756,  -1692,  -1628,  -1564,  -1500,  -1436,
   -1372,  -1308,  -1244,  -1180,  -1116,  -1052,   -988,   -924,
    -876,   -844,   -812,   -780,   -748,   -716,   -684,   -652,
    -620,   -588,   -556,   -524,   -492,   -460,   -428,   -396,
    -372,   -356,   -340,   -324,   -308,   -292,   -276,   -260,
    -244,   -228,   -212,   -196,   -180,   -164,   -148,   -132,
    -120,   -112,   -104,    -96,    -88,    -80,    -72,    -64,
     -56,    -48,    -40,    -32,    -24,    -16,     -8,      0,
   32124,  31100,  30076,  29052,  28028,  27004,  25980,  24956,
   23932,  22908,  21884,  20860,  19836,  18812,  17788,  16764,
   15996,  15484,  14972,  14460,  13948,  13436,  12924,  12412,
   11900,  11388,  10876,  10364,   9852,   9340,   8828,   8316,
    7932,   7676,   7420,   7164,   6908,   6652,   6396,   6140,
    5884,   5628,   5372,   5116,   4860,   4604,   4348,   4092,
    3900,   3772,   3644,   3516,   3388,   3260,   3132,   3004,
    2876,   2748,   2620,   2492,   2364,   2236,   2108,   1980,
    1884,   1820,   1756,   1692,   1628,   1564,   1500,   1436,
    1372,   1308,   1244,   1180,   1116,   1052,    988,    924,
     876,    844,    812,    780,    748,    716,    684,    652,
     620,    588,    556,    524,    492,    460,    428,    396,
     372,    356,    340,    324,    308,    292,    276,    260,
     244,    228,    212,    196,    180,    164,    148,    132,
     120,    112,    104,     96,     88,     80,     72,     64,
      56,     48,     40,     32,     24,     16,      8,      0,
];

function encodeUlawSample(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > _CLIP) {
    sample = _CLIP;
  }
  sample += _BIAS;

  let exponent = 7;
  const expValues = [0x4000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200, 0x0100];
  for (const expVal of expValues) {
    if (sample >= expVal) {
      break;
    }
    exponent -= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Convert PCM16 little-endian audio to ulaw.
 */
export function pcm16ToUlaw(pcm: Buffer): Buffer {
  if (!pcm.length) return Buffer.alloc(0);
  const nSamples = pcm.length >> 1;
  const out = Buffer.alloc(nSamples);
  for (let i = 0; i < nSamples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    out[i] = encodeUlawSample(sample);
  }
  return out;
}

/**
 * Convert ulaw audio to PCM16 little-endian.
 */
export function ulawToPcm16(ulaw: Buffer): Buffer {
  if (!ulaw.length) return Buffer.alloc(0);
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) {
    out.writeInt16LE(DECODE_TABLE[ulaw[i]!]!, i * 2);
  }
  return out;
}

/**
 * Resample PCM16 audio using linear interpolation.
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || !pcm.length) return pcm;

  const nSamples = pcm.length >> 1;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(nSamples / ratio);
  const out = Buffer.alloc(outLen * 2);

  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;

    let val: number;
    if (idx + 1 < nSamples) {
      val = pcm.readInt16LE(idx * 2) * (1 - frac) + pcm.readInt16LE((idx + 1) * 2) * frac;
    } else {
      val = pcm.readInt16LE(idx * 2);
    }
    out.writeInt16LE(Math.round(val), i * 2);
  }

  return out;
}

export { DECODE_TABLE };
