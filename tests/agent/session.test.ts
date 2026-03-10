import { describe, it, expect, vi } from 'vitest';
import { CallSession } from '../../src/agent/session.js';

describe('CallSession', () => {
  function makeSession() {
    const sendAudio = vi.fn();
    const clearAudio = vi.fn();
    const hangup = vi.fn();
    const session = new CallSession({
      callId: 'CA123',
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'inbound',
    });
    session._bindTransport(sendAudio, clearAudio, hangup);
    return { session, sendAudio, clearAudio, hangup };
  }

  it('initializes with call metadata', () => {
    const { session } = makeSession();
    expect(session.callId).toBe('CA123');
    expect(session.fromNumber).toBe('07012341234');
    expect(session.toNumber).toBe('01012345678');
    expect(session.accountId).toBe('AC123');
    expect(session.direction).toBe('inbound');
  });

  it('starts with ringing status before transport bind', () => {
    const session = new CallSession({
      callId: 'CA999',
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'inbound',
    });
    expect(session.status).toBe('ringing');
  });

  it('becomes active after binding transport', () => {
    const { session } = makeSession();
    expect(session.status).toBe('active');
  });

  it('sends audio via bound transport function', () => {
    const { session, sendAudio } = makeSession();
    const audio = Buffer.from([1, 2, 3]);
    session.sendAudio(audio);
    expect(sendAudio).toHaveBeenCalledWith(audio);
  });

  it('clears audio via bound transport function', () => {
    const { session, clearAudio } = makeSession();
    session.clearAudio();
    expect(clearAudio).toHaveBeenCalled();
  });

  it('hangs up via bound transport function', () => {
    const { session, hangup } = makeSession();
    session.hangup();
    expect(hangup).toHaveBeenCalled();
  });

  it('emits events and invokes handlers', () => {
    const { session } = makeSession();
    const handler = vi.fn();
    session.on('dtmf', handler);
    session._emit({ type: 'dtmf', data: '5' });
    expect(handler).toHaveBeenCalledWith({ type: 'dtmf', data: '5' });
  });

  it('marks session as ended and resolves wait()', async () => {
    const { session } = makeSession();
    const handler = vi.fn();
    session.on('ended', handler);

    session._markEnded();

    expect(session.status).toBe('ended');
    expect(handler).toHaveBeenCalled();
    await session.wait(); // should resolve immediately
  });

  it('has a duration property', () => {
    const { session } = makeSession();
    expect(typeof session.duration).toBe('number');
    expect(session.duration).toBeGreaterThanOrEqual(0);
  });

  it('does not throw when sendAudio called without transport', () => {
    const session = new CallSession({
      callId: 'CA999',
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'outbound',
    });
    expect(() => session.sendAudio(Buffer.from([1]))).not.toThrow();
  });
});
