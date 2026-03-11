import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { AudioRecorder, makeWavHeader, mixSamples } from '../../src/agent/recorder.js'

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'recorder-test-'))
}

describe('makeWavHeader', () => {
  it('generates valid 44-byte WAV header', () => {
    const header = makeWavHeader(1000)
    expect(header.length).toBe(44)
    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.toString('ascii', 8, 12)).toBe('WAVE')
    expect(header.toString('ascii', 12, 16)).toBe('fmt ')
    expect(header.readUInt32LE(16)).toBe(16)
    expect(header.readUInt16LE(20)).toBe(1)
    expect(header.readUInt16LE(22)).toBe(1)
    expect(header.readUInt32LE(24)).toBe(8000)
    expect(header.readUInt16LE(34)).toBe(16)
    expect(header.toString('ascii', 36, 40)).toBe('data')
    expect(header.readUInt32LE(40)).toBe(1000)
  })
})

describe('mixSamples', () => {
  it('adds samples correctly', () => {
    const a = Buffer.alloc(4)
    a.writeInt16LE(16, 0)
    a.writeInt16LE(32, 2)
    const b = Buffer.alloc(4)
    b.writeInt16LE(1, 0)
    b.writeInt16LE(2, 2)
    const result = mixSamples(a, b)
    expect(result.readInt16LE(0)).toBe(17)
    expect(result.readInt16LE(2)).toBe(34)
  })

  it('clips at int16 max', () => {
    const a = Buffer.alloc(2)
    a.writeInt16LE(32000, 0)
    const b = Buffer.alloc(2)
    b.writeInt16LE(32000, 0)
    const result = mixSamples(a, b)
    expect(result.readInt16LE(0)).toBe(32767)
  })
})

describe('AudioRecorder', () => {
  it('creates three WAV files on start', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-123')
    rec.start()
    const callDir = path.join(dir, 'call-123')
    expect(fs.existsSync(path.join(callDir, 'in.wav'))).toBe(true)
    expect(fs.existsSync(path.join(callDir, 'out.wav'))).toBe(true)
    expect(fs.existsSync(path.join(callDir, 'mix.wav'))).toBe(true)
    rec.stop()
  })

  it('writes inbound data to in.wav', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-in')
    rec.start()
    const pcm = Buffer.alloc(160, 1)
    rec.writeInbound(pcm)
    rec.stop()
    const callDir = path.join(dir, 'call-in')
    const inSize = fs.statSync(path.join(callDir, 'in.wav')).size
    expect(inSize).toBeGreaterThan(44 + 80)
  })

  it('writes outbound data to out.wav', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-out')
    rec.start()
    const pcm = Buffer.alloc(160, 2)
    rec.writeOutbound(pcm)
    rec.stop()
    const callDir = path.join(dir, 'call-out')
    const outSize = fs.statSync(path.join(callDir, 'out.wav')).size
    expect(outSize).toBeGreaterThan(44 + 80)
  })

  it('equalizes track lengths on stop', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-eq')
    rec.start()
    rec.writeInbound(Buffer.alloc(320, 1))
    rec.writeOutbound(Buffer.alloc(160, 2))
    rec.stop()
    const callDir = path.join(dir, 'call-eq')
    const inSize = fs.statSync(path.join(callDir, 'in.wav')).size
    const outSize = fs.statSync(path.join(callDir, 'out.wav')).size
    const mixSize = fs.statSync(path.join(callDir, 'mix.wav')).size
    expect(inSize).toBe(outSize)
    expect(outSize).toBe(mixSize)
  })

  it('does nothing before start', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-noop')
    rec.writeInbound(Buffer.alloc(160, 1))
    rec.writeOutbound(Buffer.alloc(160, 2))
    expect(fs.existsSync(path.join(dir, 'call-noop'))).toBe(false)
  })

  it('mix file contains both tracks', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-mix')
    rec.start()
    const inPcm = Buffer.alloc(8)
    inPcm.writeInt16LE(100, 0)
    inPcm.writeInt16LE(200, 2)
    inPcm.writeInt16LE(300, 4)
    inPcm.writeInt16LE(400, 6)
    const outPcm = Buffer.alloc(8)
    outPcm.writeInt16LE(10, 0)
    outPcm.writeInt16LE(20, 2)
    outPcm.writeInt16LE(30, 4)
    outPcm.writeInt16LE(40, 6)
    rec.writeInbound(inPcm)
    rec.writeOutbound(outPcm)
    rec.stop()
    const callDir = path.join(dir, 'call-mix')
    const mixData = fs.readFileSync(path.join(callDir, 'mix.wav'))
    const dataStart = 44
    expect(mixData.readInt16LE(dataStart)).toBe(110)
    expect(mixData.readInt16LE(dataStart + 2)).toBe(220)
    expect(mixData.readInt16LE(dataStart + 4)).toBe(330)
    expect(mixData.readInt16LE(dataStart + 6)).toBe(440)
  })

  it('handles zero-length call', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-zero')
    rec.start()
    rec.stop()
    const callDir = path.join(dir, 'call-zero')
    for (const name of ['in.wav', 'out.wav', 'mix.wav']) {
      const size = fs.statSync(path.join(callDir, name)).size
      expect(size).toBe(44)
    }
  })

  it('inserts silence for wall-clock gaps', () => {
    const dir = makeTmpDir()
    const rec = new AudioRecorder(dir, 'call-gap')
    const times = [0, 0, 1000]
    let callIdx = 0
    vi.spyOn(performance, 'now').mockImplementation(() => times[callIdx++] ?? 1000)

    rec.start()
    rec.writeInbound(Buffer.alloc(160, 1))
    rec.writeInbound(Buffer.alloc(160, 2))
    rec.stop()

    vi.spyOn(performance, 'now').mockRestore()

    const callDir = path.join(dir, 'call-gap')
    const inSize = fs.statSync(path.join(callDir, 'in.wav')).size - 44
    expect(inSize).toBeGreaterThanOrEqual(16000)
  })
})
