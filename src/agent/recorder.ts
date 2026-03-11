/**
 * 3-file call recording: in.wav, out.wav, mix.wav
 *
 * Wall-clock 동기화로 실시간 녹음. 세 파일 모두 동일한 길이로 유지된다.
 * recordings/{call_id}/in.wav   — 상대방 음성 (PCM16 8kHz mono)
 * recordings/{call_id}/out.wav  — AI 음성 (PCM16 8kHz mono)
 * recordings/{call_id}/mix.wav  — 양쪽 믹싱 (PCM16 8kHz mono)
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const SAMPLE_RATE = 8000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) // 16000

export function makeWavHeader(dataSize: number = 0): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), 28) // byte rate
  header.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32) // block align
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)
  return header
}

export function mixSamples(a: Buffer, b: Buffer): Buffer {
  const n = Math.min(a.length, b.length) >> 1 // sample count
  const result = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const sa = a.readInt16LE(i * 2)
    const sb = b.readInt16LE(i * 2)
    result.writeInt16LE(Math.max(-32768, Math.min(32767, sa + sb)), i * 2)
  }
  return result
}

export class AudioRecorder {
  private readonly _dir: string
  private _fdIn: number | null = null
  private _fdOut: number | null = null
  private _fdMix: number | null = null
  private _inWritten = 0
  private _outWritten = 0
  private _mixWritten = 0
  private _startTime = 0
  private _started = false

  constructor(recordingPath: string, callId: string) {
    this._dir = path.join(recordingPath, callId)
  }

  start(): void {
    fs.mkdirSync(this._dir, { recursive: true })
    const header = makeWavHeader()
    this._fdIn = fs.openSync(path.join(this._dir, 'in.wav'), 'w')
    this._fdOut = fs.openSync(path.join(this._dir, 'out.wav'), 'w')
    this._fdMix = fs.openSync(path.join(this._dir, 'mix.wav'), 'w+')
    fs.writeSync(this._fdIn, header)
    fs.writeSync(this._fdOut, header)
    fs.writeSync(this._fdMix, header)
    this._startTime = performance.now()
    this._started = true
  }

  private _expectedBytes(): number {
    const elapsed = (performance.now() - this._startTime) / 1000 // ms → s
    return (Math.floor(elapsed * BYTES_PER_SECOND) & ~1) // 2-byte align
  }

  private _padSilence(fd: number, written: number): number {
    const expected = this._expectedBytes()
    const gap = expected - written
    if (gap > 0) {
      fs.writeSync(fd, Buffer.alloc(gap))
      return written + gap
    }
    return written
  }

  private _writeToMix(data: Buffer, trackPos: number): void {
    if (this._fdMix === null) return
    const filePos = 44 + trackPos

    if (trackPos < this._mixWritten) {
      // Overlap: read existing, mix, write back
      const overlap = Math.min(data.length, this._mixWritten - trackPos)
      const existing = Buffer.alloc(overlap)
      fs.readSync(this._fdMix, existing, 0, overlap, filePos)
      const mixed = mixSamples(existing, data.subarray(0, overlap))
      fs.writeSync(this._fdMix, mixed, 0, mixed.length, filePos)
      // Write remaining beyond overlap
      if (data.length > overlap) {
        fs.writeSync(this._fdMix, data, overlap, data.length - overlap, filePos + overlap)
        this._mixWritten = trackPos + data.length
      }
    } else {
      // No overlap: pad gap if needed, then write
      if (trackPos > this._mixWritten) {
        const gap = Buffer.alloc(trackPos - this._mixWritten)
        fs.writeSync(this._fdMix, gap, 0, gap.length, 44 + this._mixWritten)
      }
      fs.writeSync(this._fdMix, data, 0, data.length, filePos)
      this._mixWritten = trackPos + data.length
    }
  }

  writeInbound(pcm16_8k: Buffer): void {
    if (!this._started || this._fdIn === null) return
    try {
      this._inWritten = this._padSilence(this._fdIn, this._inWritten)
      const posBefore = this._inWritten
      fs.writeSync(this._fdIn, pcm16_8k)
      this._inWritten += pcm16_8k.length
      this._writeToMix(pcm16_8k, posBefore)
    } catch (err) {
      console.error('Error writing inbound audio:', err)
    }
  }

  writeOutbound(pcm16_8k: Buffer): void {
    if (!this._started || this._fdOut === null) return
    try {
      this._outWritten = this._padSilence(this._fdOut, this._outWritten)
      const posBefore = this._outWritten
      fs.writeSync(this._fdOut, pcm16_8k)
      this._outWritten += pcm16_8k.length
      this._writeToMix(pcm16_8k, posBefore)
    } catch (err) {
      console.error('Error writing outbound audio:', err)
    }
  }

  stop(): void {
    if (!this._started) return
    try {
      let maxWritten = Math.max(this._inWritten, this._outWritten, this._mixWritten)
      maxWritten = maxWritten & ~1 // 2-byte align (round down)

      for (const [fd, written] of [
        [this._fdIn, this._inWritten],
        [this._fdOut, this._outWritten],
        [this._fdMix, this._mixWritten],
      ] as const) {
        if (fd === null) continue
        const pad = maxWritten - written
        if (pad > 0) {
          fs.writeSync(fd, Buffer.alloc(pad), 0, pad, 44 + written)
        }
        // Update WAV header
        fs.writeSync(fd, makeWavHeader(maxWritten), 0, 44, 0)
        fs.closeSync(fd)
      }
    } catch (err) {
      console.error('Error stopping recorder:', err)
    } finally {
      this._fdIn = null
      this._fdOut = null
      this._fdMix = null
      this._started = false
    }
  }
}
