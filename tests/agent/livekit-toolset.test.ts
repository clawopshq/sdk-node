import { describe, it, expect, vi } from 'vitest';

import { createClawOpsPhoneTools } from '../../src/agent/livekit/toolset.js';
import { BuiltinTool } from '../../src/agent/builtin-tool.js';

/** 가짜 `@livekit/agents` `llm` 네임스페이스 — tool/Toolset/ToolFlag 만 흉내낸다. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeLlm() {
  return {
    ToolFlag: { IGNORE_ON_ENTER: 1, NONE: 0 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (def: any) => ({ ...def, __tool: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Toolset: { create: (opts: any) => ({ id: opts.id, tools: opts.tools, __toolset: true }) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolNames(phone: { toolset: any }): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return phone.toolset.tools.map((t: any) => t.name);
}

describe('createClawOpsPhoneTools', () => {
  it('enabled 셋에 든 도구만 노출한다', () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), {
      enabled: new Set([BuiltinTool.HANG_UP]),
    });
    expect(toolNames(phone)).toEqual(['hang_up']);
  });

  it('네 개 전부 활성화하면 모두 노출한다', () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), {
      enabled: new Set([
        BuiltinTool.HANG_UP,
        BuiltinTool.COLLECT_DTMF,
        BuiltinTool.SEND_DTMF,
        BuiltinTool.TRANSFER_CALL,
      ]),
    });
    expect(toolNames(phone).sort()).toEqual(
      ['collect_dtmf', 'hang_up', 'send_dtmf', 'transfer_call'].sort(),
    );
  });

  it('excludeNames 에 든 도구는 뺀다 (유저 도구 이름 충돌)', () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), {
      enabled: new Set([BuiltinTool.HANG_UP, BuiltinTool.SEND_DTMF]),
      excludeNames: new Set(['hang_up']),
    });
    expect(toolNames(phone)).toEqual(['send_dtmf']);
  });

  it('hang_up/transfer_call 은 IGNORE_ON_ENTER, 나머지는 flag 없음', () => {
    const llm = fakeLlm();
    const phone = createClawOpsPhoneTools(llm, {
      enabled: new Set([BuiltinTool.HANG_UP, BuiltinTool.SEND_DTMF, BuiltinTool.TRANSFER_CALL]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byName = Object.fromEntries((phone.toolset as any).tools.map((t: any) => [t.name, t]));
    expect(byName['hang_up'].flags).toBe(llm.ToolFlag.IGNORE_ON_ENTER);
    expect(byName['transfer_call'].flags).toBe(llm.ToolFlag.IGNORE_ON_ENTER);
    expect(byName['send_dtmf'].flags).toBeUndefined();
  });

  it('setCall 전에 실행하면 에러를 던진다', async () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), { enabled: new Set([BuiltinTool.HANG_UP]) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hangUp = (phone.toolset as any).tools[0] as any;
    await expect(hangUp.execute({})).rejects.toThrow('통화가 아직 연결되지 않았습니다');
  });

  it('setCall 후 실행하면 executeBuiltinTool 로 위임한다 (hang_up → call.hangup)', async () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), { enabled: new Set([BuiltinTool.HANG_UP]) });
    const call = { hangup: vi.fn(async () => {}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phone.setCall(call as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hangUp = (phone.toolset as any).tools[0] as any;
    const result = await hangUp.execute({});
    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(result).toBe(''); // hang_up 은 빈 문자열
  });
});
