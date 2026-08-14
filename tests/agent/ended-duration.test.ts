/**
 * 서버가 확정한 통화 시간을 `CallSession.endedDuration` 으로 노출한다.
 *
 * Python SDK 의 tests/agent/test_ended_duration.py 와 짝이다.
 *
 * 왜 있나: `call.ended` 는 duration 을 실어 보내는데 SDK 가 그 값을 **읽지 않았다**. 통화
 * 기록을 자체 시스템에 적재하는 개발자는 종료 이벤트 하나로 기록을 마칠 수 없었다.
 * 서버 쪽도 같이 고쳤고(정상 종료가 0 을 보내고 있었다), **배포 순서상 서버가 먼저** 나가므로
 * 구 서버(0 또는 필드 없음)와 섞이는 구간이 실제로 있다.
 */
import { describe, it, expect, vi } from 'vitest';

import { ClawOpsAgent } from '../../src/agent/agent.js';
import { CallSession } from '../../src/agent/session.js';
import type { Session } from '../../src/agent/pipeline/base.js';

function buildSession(): Session {
  return {
    start: vi.fn(async () => {}),
    prewarm: vi.fn(async () => {}),
    attach: vi.fn(async () => {}),
    feedAudio: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as Session;
}

function makeAgentWithCall(callId = 'CA_x'): { agent: ClawOpsAgent; call: CallSession } {
  const agent = new ClawOpsAgent({
    apiKey: 'sk_test',
    accountId: 'AC123',
    from: '07012341234',
    session: buildSession(),
  });
  const call = new CallSession({
    callId,
    fromNumber: '010',
    toNumber: '070',
    accountId: 'AC',
    direction: 'inbound',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any)._activeSessions.set(callId, call);
  return { agent, call };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handleEnded = (agent: ClawOpsAgent, event: Record<string, unknown>) =>
  (agent as any)._handleEnded(event);

describe('CallSession.endedDuration', () => {
  it('서버가 준 값이 담긴다', () => {
    const { agent, call } = makeAgentWithCall();

    handleEnded(agent, { callId: 'CA_x', status: 'completed', duration: 91 });

    expect(call.endedDuration).toBe(91);
    expect(call.endedStatus).toBe('completed');
  });

  it('필드가 없으면 null 을 유지한다 — 구 서버 호환', () => {
    const { agent, call } = makeAgentWithCall();

    handleEnded(agent, { callId: 'CA_x', status: 'completed' });

    expect(call.endedDuration).toBeNull();
  });

  it('0 도 서버가 준 값이다 — 응답 전 종료는 실제로 0', () => {
    const { agent, call } = makeAgentWithCall();

    handleEnded(agent, { callId: 'CA_x', status: 'canceled', duration: 0 });

    expect(call.endedDuration).toBe(0);
  });

  it('duration(로컬 경과 시간)은 건드리지 않는다', () => {
    const { agent, call } = makeAgentWithCall();

    handleEnded(agent, { callId: 'CA_x', status: 'completed', duration: 91 });

    expect(call.duration).not.toBe(91);
  });

  it('새 세션은 null 로 시작한다', () => {
    const call = new CallSession({
      callId: 'CA_y',
      fromNumber: '010',
      toNumber: '070',
      accountId: 'AC',
      direction: 'inbound',
    });

    expect(call.endedDuration).toBeNull();
  });
});
