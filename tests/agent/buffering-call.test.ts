import { describe, it, expect, vi } from 'vitest';
import { BufferingCall, attachBuffered, logFirstRealtimeAudio } from '../../src/agent/pipeline/buffering-call.js';
import { CallSession } from '../../src/agent/session.js';

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

  it('counts dropped events by name', async () => {
    const c = new BufferingCall();
    c._emit('transcript', 'user', 'hi');
    c._emit('transcript', 'agent', 'hello');
    await c.emit('tool_call', 'check_order');
    const dropped = c.drainDroppedEvents();
    expect(dropped).toEqual({ transcript: 2, tool_call: 1 });
    // drained → empty
    expect(c.drainDroppedEvents()).toEqual({});
  });
});

describe('attachBuffered PREWARM-T markers', () => {
  function makeCallSession(callId: string): CallSession {
    return new CallSession({
      callId,
      fromNumber: '0700',
      toNumber: '0701',
      accountId: 'acct',
      direction: 'outbound',
    });
  }

  it('emits PREWARM-T first-audio source=prebuffer when chunks drained', async () => {
    const prev = new BufferingCall();
    await prev.sendAudio(Buffer.from('aaaa'));
    await prev.sendAudio(Buffer.from('bbbb'));
    const next = makeCallSession('call-xyz');
    // Avoid actual transport — sendAudio without bind is a no-op
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const flushed = attachBuffered(prev, next);
    const joined = spy.mock.calls.map(c => c.join(' ')).join('\n');
    spy.mockRestore();
    expect(flushed).toBe(true);
    expect(joined).toContain('[PREWARM-T] first-audio');
    expect(joined).toContain('call_id=call-xyz');
    expect(joined).toContain('source=prebuffer');
    expect(joined).toContain('buffered_chunks=2');
  });

  it('logs dropped events summary when prewarm absorbed _emit calls', () => {
    const prev = new BufferingCall();
    prev._emit('transcript', 'user', 'hi');
    prev._emit('transcript', 'agent', 'hello');
    prev._emit('tool_call', 'foo');
    const next = makeCallSession('call-abc');
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const flushed = attachBuffered(prev, next);
    const joined = spy.mock.calls.map(c => c.join(' ')).join('\n');
    spy.mockRestore();
    expect(flushed).toBe(false); // no audio chunks
    expect(joined).toContain('[PREWARM] dropped events during prewarm');
    expect(joined).toContain('call_id=call-abc');
    expect(joined).toContain('transcript');
    expect(joined).toContain('tool_call');
  });

  it('returns false and emits nothing when prev is not BufferingCall', () => {
    const next = makeCallSession('call-1');
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const flushed = attachBuffered(null, next);
    spy.mockRestore();
    expect(flushed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('logFirstRealtimeAudio emits source=realtime marker', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logFirstRealtimeAudio({ callId: 'call-rt' });
    const joined = spy.mock.calls.map(c => c.join(' ')).join('\n');
    spy.mockRestore();
    expect(joined).toContain('[PREWARM-T] first-audio');
    expect(joined).toContain('call_id=call-rt');
    expect(joined).toContain('source=realtime');
    expect(joined).toContain('buffered_chunks=0');
  });
});
