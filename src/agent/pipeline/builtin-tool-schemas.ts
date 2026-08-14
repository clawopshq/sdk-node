/**
 * Built-in tool 스키마 정의, 포맷 변환, 실행 헬퍼.
 *
 * 모든 세션(PipelineSession, OpenAIRealtime, GeminiRealtime)이 공통으로 사용하는
 * 내장 도구 스키마를 한 곳에서 관리한다.
 */

import { BuiltinTool } from '../builtin-tool.js';
import { createAgentLogger } from '../logger.js';
import type { CallSession } from '../session.js';

const log = createAgentLogger();

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
    'Transfer the current call to another phone number or SIP endpoint. Use for blind transfer (direct handoff) or warm transfer (with whisper message to the target).',
  parameters: {
    type: 'object' as const,
    properties: {
      to: { type: 'string' as const, description: "Transfer destination. A phone number when destination_type is 'pstn', or a SIP URI (e.g. 'sip:user@host') when destination_type is 'sip'." },
      destination_type: { type: 'string' as const, enum: ['pstn', 'sip'], description: 'pstn: dial a phone number via carrier (default). sip: connect directly to a SIP endpoint (no carrier/PSTN).' },
      mode: { type: 'string' as const, enum: ['blind', 'warm'], description: 'blind: direct transfer (default), warm: play whisper to target first' },
      after_transfer: { type: 'string' as const, enum: ['terminate', 'return'], description: 'terminate: end AI session (default), return: AI resumes after transfer ends' },
      whisper: { type: 'string' as const, description: 'Message to speak to transfer target before connecting customer (warm mode only)' },
      caller_id_mode: { type: 'string' as const, enum: ['account', 'original'], description: "What the transfer target sees as the caller. account: the account's own number (default). original: prefer the inbound caller's number, falling back to the account number when it cannot be inherited. Prefer this over caller_id." },
      caller_id: { type: 'string' as const, description: 'Exact caller ID for the transfer leg. Must be a number the account owns, or the original inbound caller. Anything else fails the transfer outright — use caller_id_mode unless a specific number is required.' },
      timeout: { type: 'integer' as const, description: 'Seconds to wait for transfer target to answer (default 30)' },
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

/** prewarm 창에서 통화 제어 도구가 호출됐을 때 모델에 돌려주는 결과. */
export const CALL_NOT_READY_RESULT =
  '통화가 아직 연결되지 않았습니다(발신 호출음 단계). 상대가 전화를 받은 뒤에 다시 시도하세요.';

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
      // Fire-and-forget: transfer 요청만 보내고 즉시 반환.
      // call-engine이 transfer 시작 시 media WS를 닫으므로,
      // 결과를 await하면 LLM 세션이 먼저 종료된다.
      call.transfer(args['to'] as string, {
        destinationType: (args['destination_type'] as 'pstn' | 'sip') ?? undefined,
        mode: (args['mode'] as 'blind' | 'warm') ?? undefined,
        afterTransfer: (args['after_transfer'] as 'terminate' | 'return') ?? undefined,
        whisper: args['whisper'] as string ?? undefined,
        callerId: args['caller_id'] as string ?? undefined,
        callerIdMode: (args['caller_id_mode'] as 'account' | 'original') ?? undefined,
        timeout: args['timeout'] as number ?? undefined,
        // 결과를 안 기다리므로 실패가 통째로 조용하다 — 모델은 "시작됨" 을 받고, 예외는
        // 프로미스 안에 갇힌다. 최소한 로그에는 남긴다.
      }).catch((e: unknown) => {
        log.error({ err: e }, 'transfer_call 도구가 건 전환이 실패했다');
      });
      return JSON.stringify({ status: 'transfer_initiated' });
    } catch (e) {
      return `Error: ${e}`;
    }
  }
  return null;
}
