import { describe, it, expect, vi } from 'vitest';

import { ClawOpsAgent } from '../../src/agent/agent.js';
import { IncomingCall } from '../../src/agent/incoming.js';
import type { Session } from '../../src/agent/pipeline/base.js';

// agent.onIncoming() — 받기 전 수신 통화 선별(clawops#1251).
/* eslint-disable @typescript-eslint/no-explicit-any */

function buildAgent(deadlineMs?: number) {
  const session = { start: async () => {}, stop: async () => {} } as unknown as Session;
  const agent = new ClawOpsAgent({
    apiKey: 'sk_test',
    accountId: 'AC123',
    from: '07012341234',
    session,
  });
  const sent: Record<string, unknown>[] = [];
  const warn = vi.fn();
  const a = agent as any;
  a._controlWs = { send: (msg: Record<string, unknown>) => sent.push(msg) };
  a._log = { info: () => {}, debug: () => {}, warn, error: () => {}, child: () => a._log };
  const startMedia = vi.fn();
  a._safeStartCallSession = startMedia;
  if (deadlineMs !== undefined) a._incomingDeadlineMs = deadlineMs;
  return { agent, a, sent, warn, startMedia };
}

const EVENT = {
  event: 'call.incoming',
  callId: 'C1',
  from: '01062915351',
  to: '07012341234',
  mediaUrl: 'wss://media/C1',
  callerIdRestricted: true,
};

describe('agent.onIncoming', () => {
  it('선별 함수가 없으면 예전 그대로 동기로 받는다 — 세션 → call.accept → 미디어', () => {
    const { a, sent, startMedia } = buildAgent();
    const order: string[] = [];
    const origSet = a._activeSessions.set.bind(a._activeSessions);
    a._activeSessions.set = (k: string, v: unknown) => (order.push('session'), origSet(k, v));
    a._controlWs.send = (m: Record<string, unknown>) => (order.push('send'), sent.push(m));
    startMedia.mockImplementation(() => order.push('media'));

    const ret = a._handleIncoming(EVENT);
    expect(ret).toBeUndefined(); // 동기 경로 그대로 — Promise 가 아니다
    expect(order).toEqual(['session', 'send', 'media']);
    expect(sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
    expect(a._activeSessions.has('C1')).toBe(true);
  });

  it('reject() 기본 사유는 rejected — 세션·미디어 없음', async () => {
    const { agent, a, sent, startMedia } = buildAgent();
    let seen: IncomingCall | undefined;
    agent.onIncoming(async (call) => {
      seen = call;
      await call.reject();
    });
    await a._handleIncoming(EVENT);
    expect(sent).toEqual([{ event: 'call.reject', callId: 'C1', reason: 'rejected' }]);
    expect(a._activeSessions.size).toBe(0);
    expect(startMedia).not.toHaveBeenCalled();
    expect(seen).toBeInstanceOf(IncomingCall);
    expect(seen!.callId).toBe('C1');
    expect(seen!.fromNumber).toBe('01062915351');
    expect(seen!.toNumber).toBe('07012341234');
    expect(seen!.callerIdRestricted).toBe(true);
    expect(seen!.rejected).toBe(true);
    expect(seen!.rejectReason).toBe('rejected');
  });

  it("reject({ reason: 'busy' }) 는 busy 를 싣는다", async () => {
    const { agent, a, sent } = buildAgent();
    agent.onIncoming(async (call) => {
      if (call.callerIdRestricted) await call.reject({ reason: 'busy' });
    });
    await a._handleIncoming(EVENT);
    expect(sent).toEqual([{ event: 'call.reject', callId: 'C1', reason: 'busy' }]);
    expect(a._activeSessions.size).toBe(0);
  });

  it('reject 하지 않고 돌아오면 받는다', async () => {
    const { agent, a, sent, startMedia } = buildAgent();
    agent.onIncoming(() => {});
    await a._handleIncoming({ ...EVENT, callerIdRestricted: false });
    expect(sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
    expect(a._activeSessions.get('C1').callerIdRestricted).toBe(false);
    expect(startMedia).toHaveBeenCalledWith(expect.anything(), 'wss://media/C1', 'C1');
  });

  it('선별 함수가 예외를 던지면 경고 후 받는다', async () => {
    const { agent, a, sent, warn } = buildAgent();
    agent.onIncoming(async () => {
      throw new Error('boom');
    });
    await a._handleIncoming(EVENT);
    expect(sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
    expect(a._activeSessions.has('C1')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('동기 예외도 같은 경로 — 받는다', async () => {
    const { agent, a, sent } = buildAgent();
    agent.onIncoming(() => {
      throw new Error('sync boom');
    });
    await a._handleIncoming(EVENT);
    expect(sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
  });

  it('상한을 넘기면 경고 후 받고, 그 뒤 reject() 는 무시된다', async () => {
    const { agent, a, sent, warn } = buildAgent(20);
    let late: Promise<void> | undefined;
    agent.onIncoming(
      (call) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            late = call.reject({ reason: 'busy' });
            resolve();
          }, 60);
        }),
    );
    await a._handleIncoming(EVENT);
    expect(sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
    expect(a._activeSessions.has('C1')).toBe(true);
    const warnsAtAccept = warn.mock.calls.length;
    expect(warnsAtAccept).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 80));
    await late;
    expect(sent).toEqual([{ event: 'call.accept', callId: 'C1' }]); // call.reject 없음
    expect(warn.mock.calls.length).toBe(warnsAtAccept + 1);
  });

  it('잘못된 reason 은 예외 — 선별 함수가 안 잡으면 받는다', async () => {
    const { agent, a, sent } = buildAgent();
    let thrown: unknown;
    agent.onIncoming(async (call) => {
      try {
        await call.reject({ reason: 'decline' as any });
      } catch (err) {
        thrown = err;
        throw err;
      }
    });
    await a._handleIncoming(EVENT);
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("'rejected' 또는 'busy'");
    expect(sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
  });

  it('reject() 두 번은 한 번만 보낸다', async () => {
    const { agent, a, sent } = buildAgent();
    agent.onIncoming(async (call) => {
      await call.reject({ reason: 'busy' });
      await call.reject();
    });
    await a._handleIncoming(EVENT);
    expect(sent).toEqual([{ event: 'call.reject', callId: 'C1', reason: 'busy' }]);
  });

  it('선별 중에 call.ended 가 오면 받지 않는다', async () => {
    const { agent, a, sent, startMedia } = buildAgent();
    let release!: () => void;
    agent.onIncoming(() => new Promise<void>((r) => (release = r)));
    const p = a._handleIncoming(EVENT);
    await Promise.resolve();
    a._handleEnded({ event: 'call.ended', callId: 'C1', status: 'canceled' });
    release();
    await p;
    expect(sent).toEqual([]);
    expect(a._activeSessions.size).toBe(0);
    expect(startMedia).not.toHaveBeenCalled();
  });

  it('to 가 없는 옛 서버면 toNumber 는 에이전트 번호', async () => {
    const { agent, a } = buildAgent();
    let seen: IncomingCall | undefined;
    agent.onIncoming((call) => {
      seen = call;
    });
    await a._handleIncoming({ event: 'call.incoming', callId: 'C2', from: '010', mediaUrl: '' });
    expect(seen!.toNumber).toBe('07012341234');
    expect(seen!.callerIdRestricted).toBe(false);
  });
});
