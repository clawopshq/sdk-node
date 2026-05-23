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
