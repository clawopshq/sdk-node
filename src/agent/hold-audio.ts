/**
 * Tool 실행 중 대기 오디오 재생.
 *
 * HoldAudioPlayer는 tool 실행 동안 caller에게 대기음을 루프 재생한다.
 */

import * as fs from 'fs';
import { pcm16ToUlaw, resamplePcm16 } from './audio';
import type { CallSession } from './session';

const CHUNK_SIZE = 160; // 20ms @ 8kHz ulaw
const SAMPLE_RATE = 8000;

// ── Bell note generation ─────────────────────────────────────

interface Partial {
  freqRatio: number;
  amplitude: number;
  decayRate: number;
}

const BELL_PARTIALS: Partial[] = [
  { freqRatio: 1.0, amplitude: 1.0, decayRate: 1.2 },
  { freqRatio: 2.76, amplitude: 0.5, decayRate: 2.5 },
  { freqRatio: 5.4, amplitude: 0.25, decayRate: 4.0 },
];

function bellNote(freq: number, durationMs: number, volume: number): Int16Array {
  const n = (SAMPLE_RATE * durationMs) / 1000 | 0;
  const attackSamples = (0.003 * SAMPLE_RATE) | 0; // 3ms attack
  const samples = new Int16Array(n);

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let val = 0;
    for (const p of BELL_PARTIALS) {
      const f = freq * p.freqRatio;
      if (f >= SAMPLE_RATE / 2) continue; // Nyquist
      const env = p.amplitude * Math.exp(-p.decayRate * t * (1000 / durationMs));
      val += env * Math.sin(2 * Math.PI * f * t);
    }
    if (i < attackSamples) {
      val *= i / attackSamples;
    }
    samples[i] = Math.max(-32768, Math.min(32767, (volume * 32767 * val) | 0));
  }
  return samples;
}

function silence(durationMs: number): Int16Array {
  return new Int16Array(((SAMPLE_RATE * durationMs) / 1000) | 0);
}

function int16ArrayToBuffer(samples: Int16Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i]!, i * 2);
  }
  return buf;
}

function concatInt16Arrays(...arrays: Int16Array[]): Int16Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Int16Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ── C5 Pentatonic scale ──────────────────────────────────────

const PENTATONIC_C5 = {
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 783.99,
  A5: 880.0,
  C6: 1046.5,
} as const;

// ── Public API ───────────────────────────────────────────────

/**
 * 뮤직박스 스타일 대기음 생성 (C5 펜타토닉 차임 멜로디).
 * 약 13초 길이가 루프 재생된다.
 */
export function generateComfortTone(volume = 0.12): Buffer[] {
  const p = PENTATONIC_C5;

  const melody: Array<[number, number]> = [
    [p.E5, 450], [p.G5, 450], [p.A5, 450], [p.C6, 600],
    [0, 800],
    [p.A5, 400], [p.G5, 400], [p.E5, 400], [p.D5, 600],
    [0, 2500],
    [p.C5, 500], [p.E5, 500], [p.C6, 700],
    [0, 2500],
  ];

  const parts: Int16Array[] = [];
  for (const [freq, durMs] of melody) {
    if (freq === 0) {
      parts.push(silence(durMs));
    } else {
      parts.push(bellNote(freq, durMs, volume));
      parts.push(silence(150)); // 음 사이 간격
    }
  }

  const pcm = int16ArrayToBuffer(concatInt16Arrays(...parts));
  const ulaw = pcm16ToUlaw(pcm);

  const chunks: Buffer[] = [];
  for (let i = 0; i < ulaw.length; i += CHUNK_SIZE) {
    chunks.push(ulaw.subarray(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/**
 * holdAudio 설정값에 따라 hold audio 청크를 로드한다.
 */
export function loadHoldAudio(source: true | string | Buffer): Buffer[] {
  if (source === true) {
    return generateComfortTone();
  }

  if (Buffer.isBuffer(source)) {
    const chunks: Buffer[] = [];
    for (let i = 0; i < source.length; i += CHUNK_SIZE) {
      chunks.push(source.subarray(i, i + CHUNK_SIZE));
    }
    return chunks;
  }

  if (typeof source === 'string') {
    const data = fs.readFileSync(source);

    // WAV header 파싱
    const riff = data.toString('ascii', 0, 4);
    if (riff !== 'RIFF') {
      throw new Error(`지원하지 않는 파일 형식입니다: ${source}`);
    }

    // fmt chunk 찾기
    let offset = 12;
    let channels = 1;
    let sampleRate = 8000;
    let bitsPerSample = 16;
    let pcmData: Buffer | null = null;

    while (offset < data.length - 8) {
      const chunkId = data.toString('ascii', offset, offset + 4);
      const chunkSize = data.readUInt32LE(offset + 4);

      if (chunkId === 'fmt ') {
        channels = data.readUInt16LE(offset + 10);
        sampleRate = data.readUInt32LE(offset + 12);
        bitsPerSample = data.readUInt16LE(offset + 22);
      } else if (chunkId === 'data') {
        pcmData = data.subarray(offset + 8, offset + 8 + chunkSize);
      }

      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset++; // padding
    }

    if (!pcmData) {
      throw new Error(`WAV data chunk을 찾을 수 없습니다: ${source}`);
    }
    if (bitsPerSample !== 16) {
      throw new Error(`16-bit PCM wav만 지원합니다 (현재: ${bitsPerSample}-bit)`);
    }

    // 스테레오 → 모노
    if (channels === 2) {
      const monoLen = pcmData.length / 2;
      const mono = Buffer.alloc(monoLen);
      for (let i = 0; i < monoLen / 2; i++) {
        mono.writeInt16LE(pcmData.readInt16LE(i * 4), i * 2);
      }
      pcmData = mono;
    }

    // 리샘플링
    if (sampleRate !== SAMPLE_RATE) {
      pcmData = resamplePcm16(pcmData, sampleRate, SAMPLE_RATE);
    }

    const ulaw = pcm16ToUlaw(pcmData);
    const chunks: Buffer[] = [];
    for (let i = 0; i < ulaw.length; i += CHUNK_SIZE) {
      chunks.push(ulaw.subarray(i, i + CHUNK_SIZE));
    }
    return chunks;
  }

  throw new TypeError(`지원하지 않는 holdAudio 타입: ${typeof source}`);
}

/**
 * Tool 실행 중 대기 오디오를 루프 재생한다.
 */
export class HoldAudioPlayer {
  private readonly _call: CallSession;
  private readonly _chunks: Buffer[];
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _index = 0;

  constructor(call: CallSession, chunks: Buffer[]) {
    this._call = call;
    this._chunks = chunks;
  }

  start(): void {
    if (this._timer !== null) return;
    this._index = 0;
    this._timer = setInterval(() => {
      if (this._index >= this._chunks.length) {
        this._index = 0; // 루프
      }
      const chunk = this._chunks[this._index++];
      if (chunk) {
        this._call.sendAudio(chunk);
      }
    }, 20); // 20ms pacing
  }

  stop(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
    this._call.clearAudio();
  }
}
