/**
 * Built-in tool 스키마 정의, 포맷 변환, 실행 헬퍼.
 *
 * 모든 세션(PipelineSession, OpenAIRealtime, GeminiRealtime)이 공통으로 사용하는
 * 내장 도구 스키마를 한 곳에서 관리한다.
 */

import { BuiltinTool } from '../builtin-tool.js';
import type { CallSession } from '../session.js';

// ── 정규 스키마 (neutral 포맷) ──────────────────────────────────────

const HANG_UP = {
  name: 'hang_up',
  description:
    'End the phone call. Use when the conversation is finished or the caller says goodbye.',
  parameters: { type: 'object' as const, properties: {} as Record<string, unknown> },
} as const;

const COLLECT_DTMF = {
  name: 'collect_dtmf',
  description:
    '사용자로부터 DTMF(전화 키패드) 입력을 수집합니다. 반드시 사용자에게 무엇을 입력해야 하는지 안내한 후 호출하세요.',
  parameters: {
    type: 'object' as const,
    properties: {
      max_digits: { type: 'integer' as const, description: '수집할 최대 자릿수' },
      finish_on_key: { type: 'string' as const, description: '입력 종료 키 (기본: #)' },
      timeout: { type: 'integer' as const, description: '입력 대기 시간(초, 기본: 5)' },
    },
    required: ['max_digits'] as string[],
  },
} as const;

const SEND_DTMF = {
  name: 'send_dtmf',
  description: 'DTMF 신호를 전송합니다. ARS 메뉴 탐색이나 내선번호 입력 시 사용합니다.',
  parameters: {
    type: 'object' as const,
    properties: {
      digits: {
        type: 'string' as const,
        description:
          "전송할 번호 (0-9, *, #). 'w'는 500ms 대기, 'W'는 1000ms 대기. 예: '1', '1234#', '1w2'",
      },
    },
    required: ['digits'] as string[],
  },
} as const;

const TRANSFER_CALL = {
  name: 'transfer_call',
  description:
    'Transfer the current call to another phone number. Use for blind transfer (direct handoff) or warm transfer (with whisper message to the target).',
  parameters: {
    type: 'object' as const,
    properties: {
      to: { type: 'string' as const, description: 'Phone number to transfer to' },
      mode: { type: 'string' as const, enum: ['blind', 'warm'], description: 'blind: direct transfer, warm: play whisper to target first' },
      after_transfer: { type: 'string' as const, enum: ['terminate', 'return'], description: 'terminate: end AI session, return: AI resumes after transfer ends' },
      hold_media: { type: 'string' as const, description: 'Hold media for customer: ringback, moh, silence' },
      whisper: { type: 'string' as const, description: 'Message to speak to transfer target (warm mode only)' },
      context: { type: 'object' as const, description: 'Structured data to pass to transfer target via webhook' },
      caller_id: { type: 'string' as const, description: 'Override caller ID for the transfer leg' },
      timeout: { type: 'integer' as const, description: 'Seconds to wait for transfer target to answer' },
    },
    required: ['to'] as string[],
  },
} as const;

type NeutralSchema = typeof HANG_UP | typeof COLLECT_DTMF | typeof SEND_DTMF | typeof TRANSFER_CALL;

const TOOL_MAP = new Map<BuiltinTool, NeutralSchema>([
  [BuiltinTool.HANG_UP, HANG_UP],
  [BuiltinTool.COLLECT_DTMF, COLLECT_DTMF],
  [BuiltinTool.SEND_DTMF, SEND_DTMF],
  [BuiltinTool.TRANSFER_CALL, TRANSFER_CALL],
]);

export const BUILTIN_TOOL_NAMES: Set<string> = new Set(
  Array.from(TOOL_MAP.values()).map((s) => s.name),
);

// ── 포맷 변환 ───────────────────────────────────────────────────────

function toChatCompletions(schema: NeutralSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    },
  };
}

function toRealtime(schema: NeutralSchema): Record<string, unknown> {
  return {
    type: 'function',
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  };
}

function toGemini(schema: NeutralSchema): Record<string, unknown> {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  };
}

const CONVERTERS = {
  chat: toChatCompletions,
  realtime: toRealtime,
  gemini: toGemini,
} as const;

/**
 * 활성화된 builtin tool 스키마를 요청한 포맷으로 반환.
 */
export function getBuiltinToolSchemas(
  builtinTools: Set<BuiltinTool> | null,
  fmt: 'chat' | 'realtime' | 'gemini',
): Array<Record<string, unknown>> {
  const converter = CONVERTERS[fmt];
  const result: Array<Record<string, unknown>> = [];
  for (const [toolEnum, schema] of TOOL_MAP) {
    if (builtinTools === null || builtinTools.has(toolEnum)) {
      result.push(converter(schema));
    }
  }
  return result;
}

// ── 공통 실행 헬퍼 ──────────────────────────────────────────────────

/**
 * Builtin tool을 실행하고 결과 문자열을 반환한다.
 *
 * `funcName`이 builtin tool이 아니면 `null`을 반환한다.
 * `hang_up`의 경우 빈 문자열 `""`을 반환한다 (호출자가 종료 처리).
 */
export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_NAMES.has(name);
}

export async function executeBuiltinTool(
  funcName: string,
  args: Record<string, unknown>,
  call: CallSession,
): Promise<string | null> {
  if (funcName === 'hang_up') {
    await call.hangup();
    return '';
  }
  if (funcName === 'collect_dtmf') {
    try {
      const result = await call.collectDtmf({
        maxDigits: (args['max_digits'] as number) ?? 4,
        finishOnKey: (args['finish_on_key'] as string) ?? '#',
        timeout: (args['timeout'] as number) ?? 5,
      });
      return result || '(타임아웃 - 입력 없음)';
    } catch (e) {
      return `Error: ${e}`;
    }
  }
  if (funcName === 'send_dtmf') {
    try {
      await call.sendDtmfSequence((args['digits'] as string) ?? '');
      return 'sent';
    } catch (e) {
      return `Error: ${e}`;
    }
  }
  if (funcName === 'transfer_call') {
    try {
      const result = await call.transfer(args['to'] as string, {
        mode: (args['mode'] as 'blind' | 'warm') ?? undefined,
        afterTransfer: (args['after_transfer'] as 'terminate' | 'return') ?? undefined,
        holdMedia: args['hold_media'] as string ?? undefined,
        whisper: args['whisper'] as string ?? undefined,
        context: args['context'] as Record<string, unknown> ?? undefined,
        callerId: args['caller_id'] as string ?? undefined,
        timeout: args['timeout'] as number ?? undefined,
      });
      return JSON.stringify(result);
    } catch (e) {
      return `Error: ${e}`;
    }
  }
  return null;
}
