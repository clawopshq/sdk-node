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

describe('종료 프레임 grace', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const awaitTerminal = (agent: ClawOpsAgent, call: CallSession) =>
    (agent as any)._awaitServerTerminal(call) as Promise<void>;

  it('프레임이 오면 즉시 풀리고 call_end 가 값을 본다', async () => {
    const { agent, call } = makeAgentWithCall();
    const seen: (number | null)[] = [];
    call.on('call_end', (c: CallSession) => {
      seen.push(c.endedDuration);
    });

    setTimeout(() => {
      handleEnded(agent, { callId: 'CA_x', status: 'completed', duration: 91 });
    }, 20);

    const started = Date.now();
    await awaitTerminal(agent, call);
    const elapsed = Date.now() - started;
    call._emit('call_end');

    expect(seen).toEqual([91]);
    // 프레임이 왔는데 상한을 다 쓰면 모든 통화의 call_end 가 그만큼 늦어진다.
    expect(elapsed).toBeLessThan(500);
  });

  it('값이 이미 있으면 기다리지 않는다', async () => {
    const { agent, call } = makeAgentWithCall();
    call._setEndedDuration(42);

    const started = Date.now();
    await awaitTerminal(agent, call);

    expect(Date.now() - started).toBeLessThan(100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any)._terminalWaiters.size).toBe(0);
  });

  it('미디어 정리 경로가 grace 를 call_end 전에 부른다 — 배선 검사', () => {
    // grace 를 만들어 놓고 정리 경로에서 안 부르면 아무 효과가 없다. 파이썬 쪽에서
    // 실제로 그 상태였고 테스트가 전부 통과했다(테스트가 helper 를 직접 불렀으니까).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (ClawOpsAgent.prototype as any)._startCallSession.toString();
    const flat = src.split(/\s+/).join(' ');

    // 따옴표 스타일은 트랜스파일마다 다르므로 이벤트 이름만 앵커로 쓴다.
    expect(flat).toContain('_awaitServerTerminal');
    const endIdx = flat.indexOf('call_end');
    expect(endIdx).toBeGreaterThan(-1);
    expect(flat.indexOf('_awaitServerTerminal')).toBeLessThan(endIdx);
  });
});
