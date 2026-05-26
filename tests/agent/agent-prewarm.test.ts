import { describe, it, expect, vi } from 'vitest';

import { ClawOpsAgent } from '../../src/agent/agent.js';
import type { Session } from '../../src/agent/pipeline/base.js';

function buildMockSession(): Session & { prewarm: ReturnType<typeof vi.fn> } {
  const sess = {
    start: vi.fn(async () => {}),
    prewarm: vi.fn(async () => {}),
    attach: vi.fn(async () => {}),
    feedAudio: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as Session & { prewarm: ReturnType<typeof vi.fn> };
  return sess;
}

function buildAgent(session: Session) {
  return new ClawOpsAgent({
    apiKey: 'sk_test',
    accountId: 'AC123',
    from: '07012341234',
    session,
  });
}

describe('ClawOpsAgent outbound prewarm', () => {
  it('handleOutboundReady starts session.prewarm() in background', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleOutboundReady({ callId: 'C1', to: '01098765432', mediaUrl: '' });
    // Allow microtasks to start the prewarm coroutine
    await Promise.resolve();
    expect(sess.prewarm).toHaveBeenCalledTimes(1);
    // The prewarm task should be tracked
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmTasks.has('C1')).toBe(true);
  });

  it('handleRinging starts session.prewarm() during ring (before answer)', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // outbound 세션은 call() 시점에 _activeSessions 에 등록되므로 ring 시점에 존재한다.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._activeSessions.set('CR1', { toNumber: '01098765432' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleRinging({ callId: 'CR1' });
    await Promise.resolve();
    expect(sess.prewarm).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmTasks.has('CR1')).toBe(true);
  });

  it('outbound_ready does not start a second prewarm after ringing', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._activeSessions.set('CR2', { toNumber: '01098765432' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleRinging({ callId: 'CR2' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleOutboundReady({ callId: 'CR2', to: '01098765432', mediaUrl: '' });
    await Promise.resolve();
    expect(sess.prewarm).toHaveBeenCalledTimes(1);
  });

  it('call() starts session.prewarm() right after originate', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // control WS 우회
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any).connect = vi.fn(async () => {});

    const fetchMock = vi.fn(async () => ({
      status: 201,
      json: async () => ({ callId: 'CO1' }),
    })) as unknown as typeof fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const call = await agent.call('07099998888');
      expect(call.callId).toBe('CO1');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((agent as any)._prewarmTasks.has('CO1')).toBe(true);
      await Promise.resolve();
      expect(sess.prewarm).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('_startPrewarm is idempotent — calling twice triggers prewarm only once', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C2');
    await Promise.resolve();
    expect(sess.prewarm).toHaveBeenCalledTimes(1);
  });

  it('prewarm failure is recorded in _prewarmFailed', async () => {
    const sess = buildMockSession();
    sess.prewarm.mockRejectedValueOnce(new Error('boom'));
    const agent = buildAgent(sess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C3');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (agent as any)._prewarmTasks.get('C3');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmFailed.has('C3')).toBe(true);
  });

  it('handleEnded cleans up prewarm bookkeeping', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C4');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmTasks.has('C4')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleEnded({ callId: 'C4' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmTasks.has('C4')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmFailed.has('C4')).toBe(false);
  });

  it('handleFailed cleans up prewarm bookkeeping', () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C5');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleFailed({ callId: 'C5', reason: 'busy' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmTasks.has('C5')).toBe(false);
  });

  it('prewarmEnabled=false skips prewarm at outbound_ready (Python mirror)', async () => {
    const sess = buildMockSession();
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: sess,
      prewarmEnabled: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleOutboundReady({ callId: 'C-disabled', to: '01000000000', mediaUrl: '' });
    await Promise.resolve();
    expect(sess.prewarm).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmTasks.has('C-disabled')).toBe(false);
  });

  it('handleEnded before attach calls session.stop() to prevent LLM WS leak', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C-leak');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const task = (agent as any)._prewarmTasks.get('C-leak') as Promise<void>;
    // hangup before attach
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleEnded({ callId: 'C-leak' });
    // wait for cleanup chain: prewarm task + stop()
    await task;
    // microtask flush
    await new Promise((r) => setTimeout(r, 10));
    expect(sess.stop).toHaveBeenCalled();
  });

  it('handleEnded after attach does NOT call stop() (normal end-path owns it)', async () => {
    const sess = buildMockSession();
    const agent = buildAgent(sess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C-attached');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._prewarmAttached.add('C-attached');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const task = (agent as any)._prewarmTasks.get('C-attached') as Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._handleEnded({ callId: 'C-attached' });
    await task;
    await new Promise((r) => setTimeout(r, 10));
    expect(sess.stop).not.toHaveBeenCalled();
  });

  it('emits [PREWARM-T] start + done markers on success (Python mirror)', async () => {
    const sess = buildMockSession();
    const infoCalls: string[] = [];
    const fakeLogger = {
      info: (msgOrObj: unknown, msg?: unknown) => {
        if (typeof msgOrObj === 'string') infoCalls.push(msgOrObj);
        else if (typeof msg === 'string') infoCalls.push(msg);
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => fakeLogger,
      level: 'info',
    };
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: sess,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: fakeLogger as any,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C-mark');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (agent as any)._prewarmTasks.get('C-mark');
    const joined = infoCalls.join('\n');
    expect(joined).toContain('[PREWARM-T] start call_id=C-mark');
    expect(joined).toMatch(/\[PREWARM-T\] done call_id=C-mark elapsed_ms=\d+/);
  });

  it('emits [PREWARM-T] failed marker with reason on failure', async () => {
    const sess = buildMockSession();
    sess.prewarm.mockRejectedValueOnce(new Error('boom-reason'));
    const warnCalls: string[] = [];
    const fakeLogger = {
      info: () => {},
      warn: (_obj: unknown, msg?: unknown) => {
        if (typeof msg === 'string') warnCalls.push(msg);
        else if (typeof _obj === 'string') warnCalls.push(_obj);
      },
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => fakeLogger,
      level: 'info',
    };
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: sess,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: fakeLogger as any,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C-fail');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (agent as any)._prewarmTasks.get('C-fail');
    const joined = warnCalls.join('\n');
    expect(joined).toContain('[PREWARM-T] failed call_id=C-fail');
    expect(joined).toContain('reason=boom-reason');
  });

  it('does not call prewarm when session.prewarm is missing (back-compat)', async () => {
    // Custom session without prewarm — should silently skip
    const legacySess = {
      start: vi.fn(async () => {}),
      feedAudio: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as Session;
    const agent = buildAgent(legacySess);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._startPrewarm('C6');
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._prewarmTasks.has('C6')).toBe(false);
  });
});
