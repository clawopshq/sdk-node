import { describe, it, expect, vi } from 'vitest';

describe('DTMF routing', () => {
  it('passive DTMF debounce flushes accumulated digits', async () => {
    const { ClawOpsAgent } = await import('../../src/agent/agent.js');

    const mockFeedDtmf = vi.fn().mockResolvedValue(undefined);
    const mockSession = {
      start: vi.fn().mockResolvedValue(undefined),
      feedAudio: vi.fn(),
      feedDtmf: mockFeedDtmf,
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const agent = new ClawOpsAgent({
      apiKey: 'test',
      accountId: 'AC_test',
      from: '01012345678',
      session: mockSession,
      passiveDtmfDebounceMs: 100,
    });

    const { CallSession } = await import('../../src/agent/session.js');
    const mockCall = new CallSession({
      callId: 'CA_test', fromNumber: '010', toNumber: '070',
      accountId: 'AC_test', direction: 'inbound',
    });

    (agent as any)._callSessions.set('CA_test', mockSession);

    (agent as any)._onDtmfEvent(mockCall, '1');
    (agent as any)._onDtmfEvent(mockCall, '2');
    (agent as any)._onDtmfEvent(mockCall, '3');

    await new Promise((r) => setTimeout(r, 200));

    expect(mockFeedDtmf).toHaveBeenCalledWith('123');
  });
});
