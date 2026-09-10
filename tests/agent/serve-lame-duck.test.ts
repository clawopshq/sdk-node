/**
 * `serve()`'s shutdown state machine — the gap and the cut are decided here.
 *
 * Before this, the slot was released the moment SIGTERM arrived. If the successor was not up
 * yet, every call that came in until it connected died — the readinessProbe was the workaround
 * that stopped the orchestrator from ever reaching that moment. Now shutdown has two phases:
 *
 *     SIGTERM ─▶ [hold the slot, keep taking calls] ─▶ [drain in-flight calls]
 *                     └ agent.retired · cap · deadline, whichever comes first
 *
 * Three things have to hold:
 *   1. once handed over, **do not release the slot again** (keep the connection so terminal
 *      events still arrive)
 *   2. the two phases share **one absolute deadline** — adding them overshoots the grace period
 *   3. SIGINT behaves as before, so Ctrl-C on a laptop does not wait 20 seconds
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { ClawOpsAgent } from '../../src/agent/agent.js';
import type { Session } from '../../src/agent/pipeline/base.js';

interface DrainCall {
  timeoutMs?: number;
  releaseSlot?: boolean;
}

function buildAgent() {
  const session = {
    start: vi.fn(async () => {}),
    attach: vi.fn(async () => {}),
    feedAudio: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as Session;

  const agent = new ClawOpsAgent({
    apiKey: 'sk_test',
    accountId: 'AC1',
    from: '07012345678',
    session,
  });

  const lameDuck = { entered: false };
  // Stand in for the control connection: serve() only needs enterLameDuck() from it.
  (agent as unknown as { _controlWs: unknown })._controlWs = {
    enterLameDuck: () => {
      lameDuck.entered = true;
    },
    close: () => {},
  };

  const seen: { drain: DrainCall | null; disconnects: number } = { drain: null, disconnects: 0 };
  agent.connect = async () => {};
  agent.drain = async (opts?: DrainCall) => {
    seen.drain = { timeoutMs: opts?.timeoutMs, releaseSlot: opts?.releaseSlot };
    return { completed: 0, forced: 0 };
  };
  agent.disconnect = async () => {
    seen.disconnects += 1;
  };

  return { agent, seen, lameDuck };
}

function raise(sig: NodeJS.Signals, afterMs: number): void {
  setTimeout(() => process.emit(sig), afterMs);
}

afterEach(() => {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('serve() shutdown', () => {
  it('keeps the slot once handed over — the connection carries the terminal events', async () => {
    const { agent, seen, lameDuck } = buildAgent();
    const served = agent.serve({ handoverWaitMs: 5_000, shutdownDeadlineMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20));
    raise('SIGTERM', 10);
    setTimeout(() => {
      (agent as unknown as { _handleRetired: (r: string) => void })._handleRetired('replaced');
    }, 150);
    await served;

    expect(seen.drain?.releaseSlot).toBe(false);
    expect(lameDuck.entered).toBe(true);
  });

  it('gives up on the handover at the cap and releases the slot', async () => {
    const { agent, seen } = buildAgent();
    const started = Date.now();
    const served = agent.serve({ handoverWaitMs: 300, shutdownDeadlineMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20));
    raise('SIGTERM', 10);
    await served;

    expect(seen.drain?.releaseSlot).toBe(true);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('splits one deadline between the two phases instead of adding them', async () => {
    const { agent, seen } = buildAgent();
    const served = agent.serve({ handoverWaitMs: 400, shutdownDeadlineMs: 3_000 });
    await new Promise((r) => setTimeout(r, 20));
    raise('SIGTERM', 10);
    await served;

    // 3000ms budget, 400ms spent waiting → roughly 2600ms left for the drain.
    expect(seen.drain?.timeoutMs).toBeGreaterThan(2_300);
    expect(seen.drain?.timeoutMs).toBeLessThan(2_750);
  });

  it('lets a shorter drain timeout win over the deadline', async () => {
    const { agent, seen } = buildAgent();
    const served = agent.serve({
      drainTimeoutMs: 500,
      handoverWaitMs: 200,
      shutdownDeadlineMs: 30_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    raise('SIGTERM', 10);
    await served;

    expect(seen.drain?.timeoutMs).toBe(500);
  });

  it('second SIGTERM stops the wait but still drains', async () => {
    const { agent, seen } = buildAgent();
    const started = Date.now();
    const served = agent.serve({ handoverWaitMs: 30_000, shutdownDeadlineMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    raise('SIGTERM', 10);
    raise('SIGTERM', 150);
    await served;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen.drain).not.toBeNull();
    expect(seen.disconnects).toBe(0);
  });

  it('SIGINT does not wait for a handover', async () => {
    const { agent, seen, lameDuck } = buildAgent();
    const started = Date.now();
    const served = agent.serve({ handoverWaitMs: 30_000, shutdownDeadlineMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    raise('SIGINT', 10);
    await served;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen.drain?.releaseSlot).toBe(true);
    expect(lameDuck.entered).toBe(false);
  });

  it('handoverWaitMs: 0 restores the old behaviour', async () => {
    const { agent, seen, lameDuck } = buildAgent();
    const started = Date.now();
    const served = agent.serve({ handoverWaitMs: 0, shutdownDeadlineMs: 30_000 });
    await new Promise((r) => setTimeout(r, 20));
    raise('SIGTERM', 10);
    await served;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen.drain?.releaseSlot).toBe(true);
    expect(lameDuck.entered).toBe(false);
  });

  it('a handover with no stop signal returns like before', async () => {
    const { agent, seen } = buildAgent();
    const served = agent.serve({ handoverWaitMs: 30_000, shutdownDeadlineMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    (agent as unknown as { _handleRetired: (r: string) => void })._handleRetired('replaced');
    await served;

    expect(seen.drain?.releaseSlot).toBe(false);
    expect(agent.takenOver).toBe(true);
  });
});

/**
 * Deadline removal (2026-09-10).
 *
 * The 110s default came from the ECS `stopTimeout` ceiling (120s) and was then applied to k8s,
 * where `terminationGracePeriodSeconds` has no ceiling. Measured against real traffic,
 * **29.8% of in-flight calls (464/1,559) run past 110s** — we were cutting calls that would
 * have finished. The only thing that ends a call now is the platform SIGKILL.
 */
describe('serve() has no deadline by default', () => {
  it('drains without a timeout — this was the 29.8% of cut calls', async () => {
    const { agent, seen } = buildAgent();
    // The handover wait stays short on purpose (it is a loss when there is no successor);
    // only the deadline goes away.
    const served = agent.serve({ handoverWaitMs: 100 });
    raise('SIGTERM', 20);
    await served;

    expect(seen.drain?.timeoutMs).toBe(Infinity);
  });

  it('still shares one budget when a deadline is given — ECS caps the grace period', async () => {
    const { agent, seen } = buildAgent();
    const served = agent.serve({ handoverWaitMs: 400, shutdownDeadlineMs: 3000 });
    raise('SIGTERM', 20);
    await served;

    // 3000ms total, ~400ms spent waiting for a handover that never came.
    expect(seen.drain?.timeoutMs).toBeGreaterThan(2300);
    expect(seen.drain?.timeoutMs).toBeLessThan(2700);
  });

  it('can still be escaped by signals — without this it would never exit locally', async () => {
    // The **real** drain() and disconnect() are used on purpose: the escape works through them.
    // A further signal calls disconnect(), which clears the active sessions, and the drain loop
    // then falls out on its next tick. With the stubs from buildAgent() this test would pass
    // while the real mechanism was broken.
    const { agent, seen } = buildAgent();
    const inner = agent as unknown as { _activeSessions: Map<string, unknown> };
    agent.drain = ClawOpsAgent.prototype.drain.bind(agent);
    agent.disconnect = async () => {
      seen.disconnects += 1;
      await ClawOpsAgent.prototype.disconnect.call(agent);
    };
    inner._activeSessions.set('CA_STUCK', { _markEnded: () => {} });

    const served = agent.serve(); // defaults = no deadline
    // serve() awaits connect() before attaching the handlers — a synchronous emit is missed.
    raise('SIGINT', 20); // 1st: skip the handover, go straight to draining
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(inner._activeSessions.size).toBe(1); // still hanging — there is no deadline

    process.emit('SIGINT'); // 2nd: cut the call still in progress
    await served;

    expect(seen.disconnects).toBeGreaterThanOrEqual(1);
    expect(inner._activeSessions.size).toBe(0);
  });
});
