import { describe, it, expect, vi } from 'vitest';
import { ClawOpsAgent } from '../../src/agent/index.js';
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
