// Real optional LiveKit runtime (no room, model, SIP, network call, or mocks).
import assert from 'node:assert/strict';
import { loadClawOpsIO } from '../dist/agent/livekit/index.js';
import { AudioFrame } from '@livekit/rtc-node';
const io = await loadClawOpsIO();
for (const [profile, rate, hz] of [['mulaw_8000', 8000, 1000], ['pcm_s16le_16000', 16000, 5000]]) {
  const chunks = [];
  const sink = { sendAudio: b => chunks.push(Buffer.from(b)), clearAudio() {} };
  const out = new io.ClawOpsAudioOutput(sink, profile);
  const input = new io.ClawOpsAudioInput(profile);
  const samples = Int16Array.from({ length: rate }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * hz * i / rate)));
  try {
    await out.captureFrame(new AudioFrame(samples, rate, 1, samples.length));
    assert.equal(chunks.length, 50);
    const reader = input.stream.getReader();
    for (const [index, chunk] of chunks.entries()) {
      input.pushAudio(chunk);
      const frame = (await reader.read()).value;
      assert.equal(frame.sampleRate, rate);
      assert.equal(frame.samplesPerChannel, rate / 50);
      if (profile === 'pcm_s16le_16000')
        assert.deepEqual(Array.from(frame.data), Array.from(samples.slice(index * rate / 50, (index + 1) * rate / 50)));
    }
    console.log(JSON.stringify({ realLiveKit: true, profile, frames: chunks.length,
      frameBytes: chunks[0].length, sampleRate: rate, durationSeconds: 1 }));
  } finally { await input.close(); out.close(); }
}
