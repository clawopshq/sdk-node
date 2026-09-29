import { describe, it, expect } from 'vitest';

import { ClawOpsAgent } from '../../src/agent/agent.js';
import { CallSession } from '../../src/agent/session.js';
import type { Session } from '../../src/agent/pipeline/base.js';

// 서버 call.incoming 의 callerIdRestricted(clawops#1249) — 발신자가 번호 표시제한을 걸었나.
function buildAgent() {
  const session = { start: async () => {}, stop: async () => {} } as unknown as Session;
  return new ClawOpsAgent({ apiKey: 'sk_test', accountId: 'AC123', from: '07012341234', session });
}

function incoming(event: Record<string, unknown>): CallSession {
  const agent = buildAgent();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any)._handleIncoming({ event: 'call.incoming', mediaUrl: '', ...event });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (agent as any)._activeSessions.get(event['callId']);
}

describe('call.incoming callerIdRestricted', () => {
  it('서버가 true 를 보내면 세션에 true, 번호는 그대로', () => {
    const call = incoming({ callId: 'C1', from: '01062915351', callerIdRestricted: true });
    expect(call.callerIdRestricted).toBe(true);
    expect(call.fromNumber).toBe('01062915351');
  });

  it('false·키 없음(옛 서버)·boolean 아닌 값은 false', () => {
    expect(incoming({ callId: 'C2', from: '010', callerIdRestricted: false }).callerIdRestricted).toBe(false);
    expect(incoming({ callId: 'C3', from: '010' }).callerIdRestricted).toBe(false);
    expect(incoming({ callId: 'C4', from: '010', callerIdRestricted: 'true' }).callerIdRestricted).toBe(false);
  });

  it('발신 세션은 false', () => {
    const call = new CallSession({
      callId: 'C5',
      fromNumber: '07012341234',
      toNumber: '010',
      accountId: 'AC123',
      direction: 'outbound',
    });
    expect(call.callerIdRestricted).toBe(false);
  });
});
