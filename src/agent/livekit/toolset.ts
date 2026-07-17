/**
 * ClawOps 전화 내장 도구를 LiveKit Toolset 으로 노출한다.
 *
 * `hang_up` / `collect_dtmf` / `send_dtmf` / `transfer_call` — 스키마와 동작을
 * `pipeline/builtin-tool-schemas.ts` 에서 그대로 재사용한다 (핸들러 중복 없음).
 *
 * 설계 메모:
 * - LiveKit 이 파는 전화 도구(`end_call`/`send_dtmf`)는 room(`get_job_context()`)을
 *   잡아 room 없이는 죽으므로 쓰지 않는다. 패턴만 가져오고 실행은 우리 것을 쓴다.
 * - `CallSession` 은 클로저 상태로 들고 간다 (prewarm -> attach 시 setCall 로 교체).
 */

import type { BuiltinTool } from '../builtin-tool.js';
import { getBuiltinToolSchemas, executeBuiltinTool } from '../pipeline/builtin-tool-schemas.js';
import type { CallSession } from '../session.js';

/** 인사말 도중 모델이 통화를 끊거나 전환하는 사고를 막는다 (ToolFlag.IGNORE_ON_ENTER). */
const IGNORE_ON_ENTER_TOOLS = new Set(['hang_up', 'transfer_call']);

export interface ClawOpsPhoneTools {
  /** LiveKit Toolset 인스턴스 — `agent.updateTools([...])` 에 넣는 ToolContextEntry. */
  toolset: unknown;
  /** prewarm -> attach 시 실제 통화로 교체한다. */
  setCall(call: CallSession): void;
}

/**
 * ClawOps 통화 제어 도구 묶음을 만든다.
 *
 * @param llm  동적 로드한 `@livekit/agents` 의 `llm` 네임스페이스 (`tool`/`Toolset`/`ToolFlag`).
 * @param options.enabled       활성화할 내장 도구 (`ClawOpsAgent(builtinTools=...)` 와 동일).
 * @param options.excludeNames  유저/registry 도구와 이름이 겹쳐 제외할 내장 도구 이름.
 */
export function createClawOpsPhoneTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llm: any,
  options: { enabled: Set<BuiltinTool>; excludeNames?: Set<string> },
): ClawOpsPhoneTools {
  const state: { call: CallSession | null } = { call: null };
  const requireCall = (): CallSession => {
    if (!state.call) {
      throw new Error('통화가 아직 연결되지 않았습니다');
    }
    return state.call;
  };

  const exclude = options.excludeNames ?? new Set<string>();
  const ignoreFlag = llm.ToolFlag?.IGNORE_ON_ENTER;

  // 활성화된 내장 도구의 정규 스키마(name/description/parameters)를 가져온다.
  const schemas = getBuiltinToolSchemas(options.enabled, 'chat') as Array<{
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;

  const tools: unknown[] = [];
  for (const schema of schemas) {
    const { name, description, parameters } = schema.function;
    if (exclude.has(name)) continue; // 유저/registry 도구와 충돌 — 내장 쪽을 뺀다.
    tools.push(
      llm.tool({
        name,
        description,
        parameters, // raw JSON schema (agents-js 가 JSONSchema7 을 그대로 받는다).
        flags: IGNORE_ON_ENTER_TOOLS.has(name) ? ignoreFlag : undefined,
        // raw schema tool 의 execute 는 파싱된 args 를 그대로 받는다.
        execute: async (args: Record<string, unknown>) =>
          (await executeBuiltinTool(name, args ?? {}, requireCall())) ?? '',
      }),
    );
  }

  const toolset = llm.Toolset.create({ id: 'clawops_phone', tools });

  return {
    toolset,
    setCall: (call: CallSession) => {
      state.call = call;
    },
  };
}
