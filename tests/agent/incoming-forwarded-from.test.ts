import { describe, it, expect } from 'vitest';

import { ClawOpsAgent } from '../../src/agent/agent.js';
import { CallSession } from '../../src/agent/session.js';
import { IncomingCall } from '../../src/agent/incoming.js';
import type { Session } from '../../src/agent/pipeline/base.js';

// 서버 call.incoming 의 forwardedFrom(clawops#1423) — 착신전환 통화에서 발신자가 원래 건 번호.
/* eslint-disable @typescript-eslint/no-explicit-any */

function buildAgent() {
  const session = { start: async () => {}, stop: async () => {} } as unknown as Session;
  const agent = new ClawOpsAgent({
    apiKey: 'sk_test',
    accountId: 'AC123',
    from: '07012341234',
    session,
  });
  const a = agent as any;
  a._controlWs = { send: () => {} };
  a._safeStartCallSession = () => {};
  return { agent, a };
}

function incoming(event: Record<string, unknown>): CallSession {
  const { a } = buildAgent();
  a._handleIncoming({ event: 'call.incoming', mediaUrl: '', ...event });
  return a._activeSessions.get(event['callId']);
}

describe('call.incoming forwardedFrom', () => {
  it('서버가 보낸 원번호를 세션에 싣는다', () => {
    const call = incoming({ callId: 'C1', from: '01011112222', forwardedFrom: '01033334444' });
    expect(call.forwardedFrom).toBe('01033334444');
    expect(call.fromNumber).toBe('01011112222');
  });

  it('키 없음(직통·옛 서버)·빈 문자열·문자열 아닌 값은 null', () => {
    expect(incoming({ callId: 'C2', from: '010' }).forwardedFrom).toBeNull();
    expect(incoming({ callId: 'C3', from: '010', forwardedFrom: '' }).forwardedFrom).toBeNull();
    expect(incoming({ callId: 'C4', from: '010', forwardedFrom: 123 }).forwardedFrom).toBeNull();
  });

  it('발신 세션은 null', () => {
    const call = new CallSession({
      callId: 'C5',
      fromNumber: '07012341234',
      toNumber: '010',
      accountId: 'AC123',
      direction: 'outbound',
    });
    expect(call.forwardedFrom).toBeNull();
  });

  it('onIncoming 의 IncomingCall 에서도 받기 전에 읽을 수 있다', async () => {
    const { agent, a } = buildAgent();
    let seen: IncomingCall | undefined;
    agent.onIncoming((call) => {
      seen = call;
    });
    await a._handleIncoming({
      event: 'call.incoming',
      callId: 'C6',
      from: '01011112222',
      to: '07012341234',
      mediaUrl: 'wss://media/C6',
      forwardedFrom: '01033334444',
    });
    expect(seen).toBeInstanceOf(IncomingCall);
    expect(seen!.forwardedFrom).toBe('01033334444');
    expect(a._activeSessions.get('C6').forwardedFrom).toBe('01033334444');
  });
});
