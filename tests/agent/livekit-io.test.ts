import { describe, it, expect, vi } from 'vitest';

// @livekit/rtc-node / @livekit/agents 는 설치되지 않을 수 있으므로 가짜로 대체한다.
vi.mock('@livekit/rtc-node', () => {
  class AudioFrame {
    data: Int16Array;
    sampleRate: number;
    channels: number;
    samplesPerChannel: number;
    constructor(data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number) {
      this.data = data;
      this.sampleRate = sampleRate;
      this.channels = channels;
      this.samplesPerChannel = samplesPerChannel;
    }
  }
  return { AudioFrame };
});

vi.mock('@livekit/agents', () => {
  class AudioOutput {
    sampleRate?: number;
    constructor(sampleRate?: number, _nextInChain?: unknown, _cap?: unknown) {
      this.sampleRate = sampleRate;
    }
    async captureFrame(_f: unknown): Promise<void> {}
    flush(): void {}
    onPlaybackStarted(_t: number): void {}
    onPlaybackFinished(_o: unknown): void {}
    clearBuffer(): void {}
  }
  return { voice: { AudioOutput } };
});

import { AudioFrame } from '@livekit/rtc-node';
import { loadClawOpsIO } from '../../src/agent/livekit/io.js';

function makeFrame(samples: number): unknown {
  return new AudioFrame(new Int16Array(samples), 8000, 1, samples);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('ClawOpsAudioInput', () => {
  it('pushUlaw → 스트림에 AudioFrame 을 넣고, endInput → 스트림 종료', async () => {
    const { ClawOpsAudioInput } = await loadClawOpsIO();
    const input = new ClawOpsAudioInput();
    const reader = (input.stream as ReadableStream<any>).getReader();

    input.pushUlaw(Buffer.alloc(160, 0xff)); // 160 μ-law 바이트 → 160 샘플
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value.samplesPerChannel).toBe(160);
    expect(first.value.sampleRate).toBe(8000);

    input.endInput();
    const end = await reader.read();
    expect(end.done).toBe(true);
  });
});

describe('ClawOpsAudioOutput', () => {
  it('captureFrame → 160바이트 μ-law 프레임으로 잘라 보내고 onPlaybackStarted 는 1회', async () => {
    const { ClawOpsAudioOutput } = await loadClawOpsIO();
    const sink = {
      sent: [] as Buffer[],
      sendAudio(b: Buffer) {
        this.sent.push(Buffer.from(b));
      },
      clearAudio() {},
    };
    const out = new ClawOpsAudioOutput(sink as any);
    const started = vi.spyOn(out as any, 'onPlaybackStarted');

    await (out as any).captureFrame(makeFrame(320)); // 320샘플 → 320 μ-law → 2×160 프레임
    expect(sink.sent.length).toBe(2);
    expect(sink.sent.every((b) => b.length === 160)).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);

    await (out as any).captureFrame(makeFrame(320)); // 두 번째는 재트리거 안 함
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('flush → mark 펜스 (echo 수신 시 interrupted=false)', async () => {
    const { ClawOpsAudioOutput } = await loadClawOpsIO();
    const media = {
      sendAudio(_b: Buffer) {},
      clearAudio() {},
      _isTransportConnected: () => true,
      _flushTransport: vi.fn(async () => {}),
      _sendMark: vi.fn((_n: string) => {}),
      _waitForMark: vi.fn(async (_n: string, _t: number) => {}), // 즉시 resolve = mark echo
    };
    const out = new ClawOpsAudioOutput(media as any);
    const finished = vi.spyOn(out as any, 'onPlaybackFinished');

    await (out as any).captureFrame(makeFrame(160));
    (out as any).flush();
    await (out as any)._flushPromise;

    expect(media._flushTransport).toHaveBeenCalledTimes(1);
    expect(media._sendMark).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect((finished.mock.calls[0]![0] as any).interrupted).toBe(false);
  });

  it('clearBuffer(barge-in) → clearAudio 호출 + interrupted=true 로 마감', async () => {
    const { ClawOpsAudioOutput } = await loadClawOpsIO();
    const media = {
      sendAudio(_b: Buffer) {},
      clearAudio: vi.fn(),
      _isTransportConnected: () => true,
      _flushTransport: vi.fn(async () => {}),
      _sendMark: vi.fn((_n: string) => {}),
      _waitForMark: vi.fn(() => new Promise<void>(() => {})), // 절대 resolve 안 함
    };
    const out = new ClawOpsAudioOutput(media as any);
    const finished = vi.spyOn(out as any, 'onPlaybackFinished');

    await (out as any).captureFrame(makeFrame(160));
    (out as any).flush();
    (out as any).clearBuffer(); // barge-in

    await (out as any)._flushPromise;
    expect(media.clearAudio).toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
    expect((finished.mock.calls[0]![0] as any).interrupted).toBe(true);
  });
});
