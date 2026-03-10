import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AudioRecorder } from '../../src/agent/recorder.js';

describe('AudioRecorder', () => {
  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
  }

  it('generates valid WAV header', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder({ outputDir: dir });
    recorder.start('CA123');
    recorder.writeInbound(Buffer.alloc(320));
    recorder.stop();
    const inFile = path.join(dir, 'CA123_inbound.wav');
    expect(fs.existsSync(inFile)).toBe(true);
    const header = Buffer.alloc(44);
    const fd = fs.openSync(inFile, 'r');
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.toString('ascii', 8, 12)).toBe('WAVE');
    fs.rmSync(dir, { recursive: true });
  });

  it('creates inbound file on write', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder({ outputDir: dir });
    recorder.start('CA123');
    recorder.writeInbound(Buffer.alloc(320));
    recorder.stop();
    expect(fs.existsSync(path.join(dir, 'CA123_inbound.wav'))).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it('accumulates multiple inbound chunks', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder({ outputDir: dir });
    recorder.start('CA123');
    recorder.writeInbound(Buffer.alloc(320));
    recorder.writeInbound(Buffer.alloc(320));
    recorder.stop();
    const stat = fs.statSync(path.join(dir, 'CA123_inbound.wav'));
    expect(stat.size).toBe(44 + 640);
    fs.rmSync(dir, { recursive: true });
  });

  it('updates WAV header data size on stop', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder({ outputDir: dir });
    recorder.start('CA123');
    recorder.writeInbound(Buffer.alloc(160));
    recorder.stop();
    const buf = fs.readFileSync(path.join(dir, 'CA123_inbound.wav'));
    const dataSize = buf.readUInt32LE(40);
    expect(dataSize).toBe(160);
    fs.rmSync(dir, { recursive: true });
  });

  it('does nothing before start is called', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder({ outputDir: dir });
    recorder.stop();
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });
});
