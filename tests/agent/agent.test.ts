import { describe, it, expect, vi } from 'vitest';
import { ClawOpsAgent, CallSession } from '../../src/agent/index.js';
import { AgentError } from '../../src/error.js';
import type { FunctionTool } from '../../src/agent/tool.js';
import type { Session } from '../../src/agent/pipeline/base.js';

// Minimal mock session for testing
const mockSession: Session = {
  start: async () => {},
  feedAudio: () => {},
  stop: async () => {},
};

describe('ClawOpsAgent', () => {
  it('initializes with required options', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: mockSession,
    });
    expect(agent).toBeDefined();
  });

  it('accepts rxGain and txGain', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: mockSession,
      rxGain: 0.8,
      txGain: 1.2,
    });
    expect((agent as unknown as { _rxGain: number })._rxGain).toBe(0.8);
    expect((agent as unknown as { _txGain: number })._txGain).toBe(1.2);
  });

  it('rejects invalid rxGain/txGain', () => {
    const base = {
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: mockSession,
    };
    expect(() => new ClawOpsAgent({ ...base, rxGain: -0.1 })).toThrow(/rxGain/);
    expect(() => new ClawOpsAgent({ ...base, txGain: Infinity })).toThrow(/txGain/);
    expect(() => new ClawOpsAgent({ ...base, rxGain: NaN })).toThrow(/rxGain/);
  });

  it('registers tools via agent.tool() with object', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: mockSession,
    });
    const tool: FunctionTool = {
      name: 'greet',
      description: 'Says hello',
      parameters: { name: { type: 'string' } },
      required: ['name'],
      handler: async ({ name }) => `Hi ${name}`,
    };
    agent.tool(tool);
  });

  it('registers tools via agent.tool() with positional args (Python-style)', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: mockSession,
    });
    agent.tool(
      'check_order',
      '주문 상태를 확인합니다.',
      { orderId: { type: 'string' } },
      async ({ orderId }) => `Order ${orderId} shipped`,
    );
  });

  it('registers event handlers via agent.on()', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012341234',
      session: mockSession,
    });
    const handler = vi.fn();
    agent.on('call_start', handler);
    agent.on('transcript', handler);
  });

  it('reads credentials from environment variables', () => {
    const origKey = process.env['CLAWOPS_API_KEY'];
    const origAccount = process.env['CLAWOPS_ACCOUNT_ID'];
    process.env['CLAWOPS_API_KEY'] = 'sk_env';
    process.env['CLAWOPS_ACCOUNT_ID'] = 'AC_env';
    try {
      const agent = new ClawOpsAgent({
        from: '07012341234',
        session: mockSession,
      });
      expect(agent).toBeDefined();
    } finally {
      if (origKey) process.env['CLAWOPS_API_KEY'] = origKey;
      else delete process.env['CLAWOPS_API_KEY'];
      if (origAccount) process.env['CLAWOPS_ACCOUNT_ID'] = origAccount;
      else delete process.env['CLAWOPS_ACCOUNT_ID'];
    }
  });

  it('throws AgentError on connect when api_key missing', async () => {
    const origKey = process.env['CLAWOPS_API_KEY'];
    delete process.env['CLAWOPS_API_KEY'];
    try {
      const agent = new ClawOpsAgent({
        accountId: 'AC123',
        from: '07012341234',
        session: mockSession,
      });
      await expect(agent.connect()).rejects.toThrow(AgentError);
    } finally {
      if (origKey) process.env['CLAWOPS_API_KEY'] = origKey;
    }
  });

  it('throws AgentError on connect when account_id missing', async () => {
    const origAccount = process.env['CLAWOPS_ACCOUNT_ID'];
    delete process.env['CLAWOPS_ACCOUNT_ID'];
    try {
      const agent = new ClawOpsAgent({
        apiKey: 'sk_test',
        from: '07012341234',
        session: mockSession,
      });
      await expect(agent.connect()).rejects.toThrow(AgentError);
    } finally {
      if (origAccount) process.env['CLAWOPS_ACCOUNT_ID'] = origAccount;
    }
  });
});

describe('ClawOpsAgent machineDetection', () => {
  const base = {
    apiKey: 'sk_test',
    accountId: 'AC123',
    from: '07012341234',
    session: mockSession,
    // prewarm 은 이 테스트와 무관 — LLM WS 연결 side-effect 회피.
    prewarmEnabled: false,
  };

  const asField = (agent: ClawOpsAgent) =>
    (agent as unknown as { _machineDetection?: 'Enable' | 'Hangup' })._machineDetection;

  it('stores instance-level machineDetection default', () => {
    expect(asField(new ClawOpsAgent({ ...base, machineDetection: 'Hangup' }))).toBe('Hangup');
  });

  it('defaults machineDetection to undefined', () => {
    expect(asField(new ClawOpsAgent({ ...base }))).toBeUndefined();
  });

  const mockOriginate = () =>
    vi.fn(
      async () =>
        ({ status: 201, json: async () => ({ callId: 'CO1' }) }) as unknown as Response,
    );

  const postedBody = (fetchMock: ReturnType<typeof mockOriginate>) => {
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    return JSON.parse(init.body as string);
  };

  const stubConnect = (agent: ClawOpsAgent) => {
    (agent as unknown as { connect: () => Promise<void> }).connect = async () => {};
  };

  it('omits MachineDetection in body when unset', async () => {
    const agent = new ClawOpsAgent({ ...base });
    stubConnect(agent);
    const fetchMock = mockOriginate();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await agent.call('07099998888');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(postedBody(fetchMock)).not.toHaveProperty('MachineDetection');
  });

  it('applies instance default to originate body', async () => {
    const agent = new ClawOpsAgent({ ...base, machineDetection: 'Hangup' });
    stubConnect(agent);
    const fetchMock = mockOriginate();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await agent.call('07099998888');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(postedBody(fetchMock)['MachineDetection']).toBe('Hangup');
  });

  it('call arg overrides instance default (호출 인자 > default)', async () => {
    const agent = new ClawOpsAgent({ ...base, machineDetection: 'Hangup' });
    stubConnect(agent);
    const fetchMock = mockOriginate();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await agent.call('07099998888', { machineDetection: 'Enable' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(postedBody(fetchMock)['MachineDetection']).toBe('Enable');
  });
});

// ── 종료 상태 통보 (call.ended 의 status 반영) ──────────────────────────────
// 배경: 서버는 call.ended 에 종료 사유를 status 로 싣지만 예전 _handleEnded 는 이 값을
// 버려서, 상대가 받지 않은 통화(no-answer)가 성사된 통화와 구분되지 않았다.
describe('ClawOpsAgent — 종료 상태 통보', () => {
  const base = {
    apiKey: 'sk_test',
    accountId: 'AC123',
    from: '07012341234',
    session: mockSession,
  };

  function registerOutbound(agent: ClawOpsAgent, callId: string): CallSession {
    const call = new CallSession({
      callId,
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'outbound',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._activeSessions.set(callId, call);
    return call;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEnded = (agent: ClawOpsAgent, event: Record<string, unknown>) =>
    (agent as any)._handleEnded(event);

  it.each(['no-answer', 'busy', 'rejected', 'canceled', 'failed'])(
    '미연결 종료(%s)는 endedStatus 에 사유를 남기고 call_failed 를 발화한다',
    async (status) => {
      const agent = new ClawOpsAgent(base);
      const call = registerOutbound(agent, `CT-${status}`);
      const seen: string[] = [];
      call.on('call_failed', async (_c, reason) => {
        seen.push(reason as string);
      });

      handleEnded(agent, { callId: `CT-${status}`, status });

      expect(call.endedStatus).toBe(status);
      expect(seen).toEqual([status]);
      // wait() 는 무응답에서도 반드시 풀려야 한다(행 방지).
      await call.wait();
    },
  );

  it('성사된 통화에서는 call_failed 가 발화되지 않는다', async () => {
    const agent = new ClawOpsAgent(base);
    const call = registerOutbound(agent, 'CT-ok');
    const seen: string[] = [];
    call.on('call_failed', async (_c, reason) => {
      seen.push(reason as string);
    });

    handleEnded(agent, { callId: 'CT-ok', status: 'completed' });

    expect(call.endedStatus).toBe('completed');
    expect(seen).toEqual([]);
    await call.wait();
  });

  it('status 없는 구버전 이벤트는 completed 로 간주한다 (하위호환)', async () => {
    const agent = new ClawOpsAgent(base);
    const call = registerOutbound(agent, 'CT-legacy');

    handleEnded(agent, { callId: 'CT-legacy' });

    expect(call.endedStatus).toBe('completed');
    expect(call.status).toBe('ended');
  });

  it('미디어 정리의 인자 없는 _markEnded() 가 서버 종료 사유를 덮어쓰지 않는다', () => {
    const agent = new ClawOpsAgent(base);
    const call = registerOutbound(agent, 'CT-keep');

    handleEnded(agent, { callId: 'CT-keep', status: 'no-answer' });
    call._markEnded();

    expect(call.endedStatus).toBe('no-answer');
  });
});
