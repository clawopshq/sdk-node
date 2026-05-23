import { describe, it, expect } from 'vitest';
import { BufferingCall } from '../../src/agent/pipeline/buffering-call.js';

describe('BufferingCall', () => {
  it('buffers sendAudio chunks in order', async () => {
    const c = new BufferingCall();
    await c.sendAudio(Buffer.from('a'));
    await c.sendAudio(Buffer.from('b'));
    const drained = c.drainBuffer();
    expect(drained).toEqual([Buffer.from('a'), Buffer.from('b')]);
  });

  it('drain empties buffer', async () => {
    const c = new BufferingCall();
    await c.sendAudio(Buffer.from('x'));
    c.drainBuffer();
    expect(c.drainBuffer()).toEqual([]);
  });

  it('_emit is no-op', () => {
    const c = new BufferingCall();
    expect(() => c._emit('transcript', 'user', 'hi')).not.toThrow();
  });

  it('emit (async) is no-op', async () => {
    const c = new BufferingCall();
    await expect(c.emit('transcript', 'user', 'hi')).resolves.toBeUndefined();
  });

  it('metrics.recordToolCall is no-op', () => {
    const c = new BufferingCall();
    expect(() => c.metrics.recordToolCall()).not.toThrow();
  });
});
