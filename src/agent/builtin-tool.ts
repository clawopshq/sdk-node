/**
 * Built-in tool definitions and selection constants.
 */

export enum BuiltinTool {
  /** 전화 종료 도구. AI가 대화 완료 시 통화를 종료합니다. */
  HANG_UP = 'hang_up',
  /** DTMF 수집 도구. 사용자의 키패드 입력을 수집합니다. */
  COLLECT_DTMF = 'collect_dtmf',
  /** DTMF 전송 도구. ARS 탐색이나 내선번호 입력에 사용합니다. */
  SEND_DTMF = 'send_dtmf',

  /** 모든 내장 도구를 활성화합니다. (기본값) */
  ALL = 'all',
  /** 모든 내장 도구를 비활성화합니다. */
  NONE = 'none',
}

const INDIVIDUAL_TOOLS = new Set([
  BuiltinTool.HANG_UP,
  BuiltinTool.COLLECT_DTMF,
  BuiltinTool.SEND_DTMF,
]);

export function resolveBuiltinTools(
  value: BuiltinTool | BuiltinTool[],
): Set<BuiltinTool> {
  if (typeof value === 'string') {
    if (value === BuiltinTool.ALL) {
      return new Set(INDIVIDUAL_TOOLS);
    }
    if (value === BuiltinTool.NONE) {
      return new Set();
    }
    return new Set([value]);
  }
  return new Set(value.filter((t) => INDIVIDUAL_TOOLS.has(t)));
}
