/**
 * AudioRecorder writes inbound and outbound audio to a WAV file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const WAV_SAMPLE_RATE = 8000;
const WAV_CHANNELS = 1;
const WAV_BITS_PER_SAMPLE = 16;

/**
 * Generate a WAV file header for the given data size.
 */
function makeWavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = WAV_SAMPLE_RATE * WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);
  const blockAlign = WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  // fmt sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Sub-chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(WAV_CHANNELS, 22);
  header.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(WAV_BITS_PER_SAMPLE, 34);

  // data sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

export interface RecorderOptions {
  /** Output directory for recordings. */
  outputDir: string;
  /** Sample rate of audio data. Default: 8000 */
  sampleRate?: number;
}

export class AudioRecorder {
  private readonly _outputDir: string;
  private readonly _sampleRate: number;
  private _inboundChunks: Buffer[] = [];
  private _outboundChunks: Buffer[] = [];
  private _callId: string | null = null;
  private _started = false;

  constructor(options: RecorderOptions) {
    this._outputDir = options.outputDir;
    this._sampleRate = options.sampleRate ?? WAV_SAMPLE_RATE;
  }

  /** Start recording for a call. */
  start(callId: string): void {
    this._callId = callId;
    this._inboundChunks = [];
    this._outboundChunks = [];
    this._started = true;

    // Ensure output directory exists
    if (!fs.existsSync(this._outputDir)) {
      fs.mkdirSync(this._outputDir, { recursive: true });
    }
  }

  /** Write inbound (caller) PCM16 audio. */
  writeInbound(pcm: Buffer): void {
    if (this._started) {
      this._inboundChunks.push(Buffer.from(pcm));
    }
  }

  /** Write raw outbound (agent) PCM16 audio. */
  writeRawOutbound(pcm: Buffer): void {
    if (this._started) {
      this._outboundChunks.push(Buffer.from(pcm));
    }
  }

  /** Stop recording and write WAV files to disk. Returns file paths. */
  stop(): { inbound?: string; outbound?: string } {
    if (!this._started || !this._callId) {
      return {};
    }

    this._started = false;
    const result: { inbound?: string; outbound?: string } = {};

    if (this._inboundChunks.length > 0) {
      const inboundPath = path.join(this._outputDir, `${this._callId}_inbound.wav`);
      this._writeWav(inboundPath, this._inboundChunks);
      result.inbound = inboundPath;
    }

    if (this._outboundChunks.length > 0) {
      const outboundPath = path.join(this._outputDir, `${this._callId}_outbound.wav`);
      this._writeWav(outboundPath, this._outboundChunks);
      result.outbound = outboundPath;
    }

    this._inboundChunks = [];
    this._outboundChunks = [];

    return result;
  }

  private _writeWav(filePath: string, chunks: Buffer[]): void {
    const pcmData = Buffer.concat(chunks);
    const header = makeWavHeader(pcmData.length);
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, header);
    fs.writeSync(fd, pcmData);
    fs.closeSync(fd);
  }
}
