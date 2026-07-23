/**
 * prewarm 이 agent.tool / MCP 도구를 누락하지 않는지 검증.
 *
 * 회귀 대상: 발신 통화는 originate 직후 prewarm 이 돌면서 LLM 에 tool 스키마를
 * 확정 전송하는데, 도구 주입(_startCallSession)은 상대가 받은 뒤에야 실행돼
 * 유저 도구가 통째로 빠진 채 통화가 시작됐다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ClawOpsAgent } from '../../src/agent/agent.js';
import { OpenAIRealtime } from '../../src/agent/pipeline/realtime/openai-realtime.js';
import { ToolRegistry } from '../../src/agent/tool.js';
import type { Session } from '../../src/agent/pipeline/base.js';

type Handler = (...args: unknown[]) => void;
let mockInstances: MockWs[] = [];

class MockWs {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private _handlers = new Map<string, Handler[]>();

  constructor() {
    mockInstances.push(this);
  }
  on(event: string, fn: Handler): this {
    const arr = this._handlers.get(event) ?? [];
    arr.push(fn);
    this._handlers.set(event, arr);
    if (event === 'open') queueMicrotask(() => fn());
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    for (const fn of this._handlers.get('close') ?? []) fn();
  }
}

vi.mock('ws', () => ({ WebSocket: MockWs }));

function registryWith(name: string): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name,
    description: '테스트용 도구',
    parameters: { query: { type: 'string' } },
    required: [],
    handler: async () => 'ok',
  });
  return reg;
}

function sessionUpdates(ws: MockWs): Array<Record<string, any>> {
  return ws.sent
    .map((s) => JSON.parse(s) as Record<string, any>)
    .filter((m) => m['type'] === 'session.update');
}

function toolNames(update: Record<string, any>): string[] {
  return ((update['session']?.['tools'] ?? []) as Array<Record<string, unknown>>).map(
    (t) => String(t['name']),
  );
}

function mockCall(): any {
  return {
    sendAudio: vi.fn(),
    sendClear: vi.fn(),
    _emit: vi.fn(),
    recordFirstResponse: vi.fn(),
    metrics: {},
  };
}

// ── 세션 레벨 ────────────────────────────────────────────────────────

describe('OpenAIRealtime tool resync', () => {
  beforeEach(() => {
    mockInstances = [];
  });

  it('prewarm 전에 주입된 도구는 첫 session.update 에 실린다', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    sess.setToolRegistry(registryWith('query_prometheus'));
    await sess.prewarm();

    const updates = sessionUpdates(mockInstances[0]!);
    expect(updates).toHaveLength(1);
    expect(toolNames(updates[0]!)).toContain('query_prometheus');
  });

  it('prewarm 이후 붙은 도구(MCP)는 attach 에서 재전송된다', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    await sess.prewarm();
    expect(toolNames(sessionUpdates(mockInstances[0]!)[0]!)).not.toContain('late_tool');

    sess.setToolRegistry(registryWith('late_tool'));
    await sess.attach(mockCall());

    const updates = sessionUpdates(mockInstances[0]!);
    expect(updates).toHaveLength(2);
    expect(toolNames(updates[1]!)).toContain('late_tool');
  });

  it('prewarm 창의 builtin 호출은 Unknown tool 이 아니라 안내 결과를 돌려준다', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    await sess.prewarm();

    await (sess as any)._handleToolCall({
      name: 'hang_up',
      call_id: 'call_1',
      arguments: '{}',
    });

    const outputs = mockInstances[0]!.sent
      .map((s) => JSON.parse(s) as Record<string, any>)
      .filter((m) => m['type'] === 'conversation.item.create')
      .map((m) => m['item']['output'] as string);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain('연결되지 않았습니다');
  });

  it('도구가 그대로면 재전송하지 않는다', async () => {
    const sess = new OpenAIRealtime({ apiKey: 'sk-test', greeting: false });
    sess.setToolRegistry(registryWith('query_prometheus'));
    await sess.start(mockCall());
    expect(sessionUpdates(mockInstances[0]!)).toHaveLength(1);
  });
});

// ── 에이전트 레벨 ────────────────────────────────────────────────────

function buildMockSession(extra: Record<string, unknown> = {}) {
  const order: string[] = [];
  const sess = {
    start: vi.fn(async () => {}),
    prewarm: vi.fn(async () => {
      order.push('prewarm');
    }),
    attach: vi.fn(async () => {}),
    feedAudio: vi.fn(),
    stop: vi.fn(async () => {}),
    setToolRegistry: vi.fn(() => {
      order.push('tools');
    }),
    setBuiltinTools: vi.fn(),
    ...extra,
  } as unknown as Session & Record<string, any>;
  return { sess, order };
}

function buildAgent(session: Session, options: Record<string, unknown> = {}) {
  return new ClawOpsAgent({
    apiKey: 'sk_test',
    accountId: 'AC123',
    from: '07012341234',
    session,
    ...options,
  });
}

describe('ClawOpsAgent prewarm tool injection', () => {
  it('prewarm 호출 전에 도구를 주입한다', async () => {
    const { sess, order } = buildMockSession();
    const agent = buildAgent(sess);
    agent.tool({
      name: 'query_prometheus',
      description: '테스트용 도구',
      parameters: { query: { type: 'string' } },
      required: [],
      handler: async () => 'ok',
    });

    (agent as any)._startPrewarm('C1');
    await (agent as any)._prewarmTasks.get('C1');

    expect(order).toEqual(['tools', 'prewarm']);
    const injected = (sess as any).setToolRegistry.mock.calls[0][0] as ToolRegistry;
    expect(injected.toOpenAITools().map((t: any) => t.function.name)).toContain(
      'query_prometheus',
    );
  });

  it('도구 고정 세션(Gemini) + MCP 조합이면 prewarm 을 건너뛴다', async () => {
    const { sess } = buildMockSession({ toolsFrozenAfterPrewarm: true });
    const agent = buildAgent(sess, {
      mcpServers: [{ url: 'https://example.com/mcp' }],
    });

    (agent as any)._startPrewarm('C1');
    expect((agent as any)._prewarmTasks.has('C1')).toBe(false);
    expect((sess as any).prewarm).not.toHaveBeenCalled();
  });

  it('MCP 가 없으면 도구 고정 세션도 정상 prewarm 한다', async () => {
    const { sess } = buildMockSession({ toolsFrozenAfterPrewarm: true });
    const agent = buildAgent(sess);

    (agent as any)._startPrewarm('C2');
    await (agent as any)._prewarmTasks.get('C2');
    expect((sess as any).prewarm).toHaveBeenCalledTimes(1);
  });
});
