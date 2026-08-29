import type {
  SolapiMessageService,
  RequestSendMessagesSchema,
  SendRequestConfigSchema,
  DetailGroupMessageResponse,
} from 'solapi';
import type { ClawOps } from '../client.js';
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from './_concurrency.js';
import { clawopsType, normalizePhone, upperType } from './_message-type.js';
import { deliverFallback } from './_fallback.js';
import { SolapiBridgeError } from '../error.js';
import { type FallbackSource, type FallbackText, type SolapiMessage } from './fallback-text.js';
import {
  sweepFailedAlimtalk,
  FALLBACK_MARKER_FIELD,
  FALLBACK_MARKER_VALUE,
  type SweepCursor,
  type SweepOptions,
} from './sweep.js';

export {
  resolveFallbackText,
  DEFAULT_FALLBACK_FIELD,
  type FallbackSource,
  type FallbackText,
  type SolapiMessage,
} from './fallback-text.js';
export { SolapiBridgeError } from '../error.js';
export {
  sweepFailedAlimtalk,
  DEFAULT_FALLBACK_CODES,
  FALLBACK_MARKER_FIELD,
  type SweepCursor,
  type SweepOptions,
  type SweepResult,
} from './sweep.js';

type GroupInfo = DetailGroupMessageResponse['groupInfo'];
type Sent = NonNullable<DetailGroupMessageResponse['messageList']>[number];
type Failed = DetailGroupMessageResponse['failedMessageList'][number];

/** ClawOps 에 대응 개념이 없는 솔라피 집계 필드 */
const ZERO_CASH = { requested: 0, replacement: 0, refund: 0, sum: 0 } as const;
const CHARGE_KEYS = [
  'sms',
  'lms',
  'mms',
  'ata',
  'cta',
  'cti',
  'nsa',
  'rcs_sms',
  'rcs_lms',
  'rcs_mms',
  'rcs_tpl',
] as const;
const NO_CHARGE = Object.fromEntries(
  CHARGE_KEYS.map((k) => [k, {}]),
) as GroupInfo['countForCharge'];
const NO_PROFIT = Object.fromEntries(CHARGE_KEYS.map((k) => [k, 0])) as GroupInfo['app']['profit'];

/** ClawOps 가 보내는 메시지 타입 */
const OURS = new Set(['SMS', 'LMS', 'MMS']);

/**
 * 벤더 전용 옵션. 하나라도 있으면 우리 몫이 아니다.
 *
 * solapi 의 `type` 은 optional 이고 서버가 옵션으로 종류를 추론한다.
 * `type` 만 보고 가르면 `send({ to, from, kakaoOptions })` 같은 흔한 알림톡이
 * 문자 경로로 새어 빈 본문으로 나간다.
 */
const VENDOR_OPTION_FIELDS = [
  'kakaoOptions',
  'rcsOptions',
  'naverOptions',
  'voiceOptions',
  'faxOptions',
] as const;

const hasVendorOptions = (message: SolapiMessage): boolean =>
  VENDOR_OPTION_FIELDS.some((field) => message[field] != null);

const recipientsOf = (to: string | readonly string[]): readonly string[] =>
  Array.isArray(to) ? to : [to as string];

/** 우리가 접수하지 못한 건임을 알리는 코드. 솔라피 코드 체계와 겹치지 않는다 */
export const CLAWOPS_FAILURE_STATUS_CODE = 'CLAWOPS';

export interface FallbackEvent {
  to: string;
  source: FallbackSource;
  text: string;
  /** 스윕에서 온 경우에만 채워진다 */
  messageId?: string;
  statusCode?: string;
}

export type FallbackBlockedEvent = {
  to: string;
  messageId?: string;
  statusCode?: string;
} & (
  | Extract<FallbackText, { ok: false }>
  /** 스윕에서만 — 실패했지만 대체발송 대상 코드가 아니다 */
  | { ok: false; reason: 'code_not_eligible' }
  /** 스윕에서만 — 문구는 만들었는데 ClawOps 가 거절했다 */
  | { ok: false; reason: 'send_rejected' }
);

/**
 * 발송 실패 추적 방식.
 *
 * `polling`·`webhook` 은 일부러 넣지 않았다 — 유니온에 멤버를 추가하는 것은 하위호환이라
 * 필요해지면 그때 붙이면 되고, 미리 선언하면 지키지 못할 약속이 된다.
 */
export type FallbackTracking =
  /**
   * 접수 실패(1XXX)만 대체발송. `send()` 응답으로 즉시 판정된다.
   * 추적 옵션은 받지 않는다 — `mode` 없이 `lookbackMs` 를 써 놓고 스윕이 돈다고 오해하는 것을 막는다
   */
  | {
      mode?: undefined;
      intervalMs?: never;
      lookbackMs?: never;
      on?: never;
      initialCursor?: never;
      onCursor?: never;
      onError?: never;
    }
  /**
   * 리포트를 주기적으로 훑어 발송 실패(3XXX)까지 대체발송한다.
   * 수신자가 카카오톡을 쓰지 않거나 알림톡을 차단한 경우가 여기 해당한다.
   */
  | {
      mode: 'sweep';
      /** 스윕 주기. 기본 5분 */
      intervalMs?: number;
      /** 커서가 없을 때 거슬러 볼 구간. 기본 1시간 */
      lookbackMs?: number;
      /** 대체발송할 상태코드. 기본 3104·3107·3102 */
      on?: readonly string[];
      /** 훑을 메시지 타입. 기본은 알림톡만 — 친구톡까지 보려면 넓힌다 */
      types?: SweepOptions['types'];
      /** 프로세스 밖에 커서를 저장했다가 넘길 때 */
      initialCursor?: SweepCursor;
      onCursor?: (cursor: SweepCursor) => void;
      /** 스윕 자체가 실패했을 때. 지정하지 않으면 조용히 다음 주기에 재시도한다 */
      onError?: (error: unknown) => void;
    };

export type FallbackConfig =
  | boolean
  /**
   * 끈 상태. 다른 옵션은 받지 않는다 —
   * `{ enabled: false, mode: 'sweep' }` 처럼 써 놓고 스윕이 돈다고 오해하는 것을 막는다
   */
  | {
      enabled: false;
      mode?: never;
      field?: never;
      onFallback?: never;
      onBlocked?: never;
    }
  | ({
      enabled: true;
      /** 대체 문구를 읽어올 customFields 키 */
      field?: string;
      onFallback?: (event: FallbackEvent) => void;
      onBlocked?: (event: FallbackBlockedEvent) => void;
    } & FallbackTracking);

/** 켜진 설정. 사용자가 준 모양 그대로라 필드를 옮겨 담을 필요가 없다 */
type EnabledFallback = Extract<FallbackConfig, { enabled: true }>;

/** 꺼져 있으면 undefined. 켜져 있으면 원래 유니온 arm 을 그대로 돌려준다 */
function normalizeFallback(config: FallbackConfig | undefined): EnabledFallback | undefined {
  if (config === undefined || config === true) return { enabled: true };
  if (config === false || !config.enabled) return undefined;
  return config;
}

export interface ClawOpsMessageServiceOptions {
  /** ClawOps 클라이언트 */
  clawops: ClawOps;
  /** 문자 기본 발신번호. ClawOps 에 등록된 번호여야 한다 */
  from: string;
  /** 알림톡·RCS 등을 계속 쓸 때 넘긴다. 없으면 문자 전용 모드 */
  solapi?: SolapiMessageService;
  /**
   * 알림톡 실패 시 문자로 대체발송.
   * 기본은 접수 실패(1XXX)만 — 발송 실패(3XXX)까지 잡으려면 `mode: 'sweep'` 을 켠다.
   */
  fallback?: FallbackConfig;
  /** 동시에 띄우는 ClawOps 요청 수. 기본 10 */
  concurrency?: number;
}

/** solapi 는 send 만 노출하고 나머지는 감춘 문자 전용 서비스 */
export type ClawOpsTextOnlyService = Pick<SolapiMessageService, 'send'>;

/**
 * 전건이 접수 실패하면 solapi SDK 는 결과 대신 MessageNotReceivedError 를 던진다.
 * 예외지만 정상 경로이고, 안에 실패 목록이 들어 있다.
 */
function isMessageNotReceived(error: unknown): error is { failedMessageList: Failed[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'failedMessageList' in error &&
    Array.isArray((error as { failedMessageList: unknown }).failedMessageList)
  );
}

/**
 * ClawOps 로 가는 메시지가 있는데 우리가 지킬 수 없는 발송 설정이 오면 막는다.
 * 조용히 버리면 예약 발송이 즉시 발송으로 바뀐다.
 */
function assertConfigSupported(config: SendRequestConfigSchema | undefined): void {
  if (!config) return;
  const unsupported: string[] = [];
  if (config.scheduledDate !== undefined) unsupported.push('scheduledDate');
  if (config.allowDuplicates === false) unsupported.push('allowDuplicates: false');
  if (unsupported.length > 0) {
    throw new SolapiBridgeError(
      `ClawOps 로 보내는 메시지에는 ${unsupported.join(', ')} 를 적용할 수 없습니다. ` +
        '해당 설정이 필요한 발송은 솔라피로 보내거나 호출을 분리하십시오.',
    );
  }
}

function makeGroupInfo(
  base: GroupInfo | null,
  counts: { ok: number; failed: number; replacement: number },
): GroupInfo {
  if (base) {
    // 솔라피 집계에 **우리 몫을 더한다**. 덮어쓰면 안 된다 —
    // `messageList` 는 `showMessageList: true` 일 때만 오므로 기본 호출에서는 비어 있고,
    // 우리가 센 값으로 덮으면 알림톡 물량이 통째로 0 이 된다.
    // 대체발송분은 솔라피가 이미 실패로 세어 놨으므로 total 에 더하지 않고
    // sentReplacement 로만 올린다 — 솔라피와 같은 의미다
    return {
      ...base,
      count: {
        ...base.count,
        total: base.count.total + counts.ok + counts.failed,
        registeredSuccess: base.count.registeredSuccess + counts.ok,
        registeredFailed: base.count.registeredFailed + counts.failed,
        sentReplacement: base.count.sentReplacement + counts.replacement,
      },
    };
  }

  const registered = {
    total: counts.ok + counts.failed,
    registeredSuccess: counts.ok,
    registeredFailed: counts.failed,
  };

  const now = new Date().toISOString();
  return {
    count: {
      ...registered,
      sentTotal: 0,
      sentFailed: 0,
      sentSuccess: 0,
      sentPending: 0,
      sentReplacement: counts.replacement,
      refund: 0,
    },
    countForCharge: NO_CHARGE,
    balance: ZERO_CASH,
    point: ZERO_CASH,
    app: { profit: NO_PROFIT, appId: null },
    log: [],
    status: 'PENDING',
    allowDuplicates: false,
    isRefunded: false,
    accountId: '',
    masterAccountId: null,
    apiVersion: '4',
    // 솔라피 그룹이 아니므로 getGroupMessages 로 조회되지 않는다. 접두사로 구분한다
    groupId: `CLAWOPS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    price: {},
    dateCreated: now,
    dateUpdated: now,
    scheduledDate: null,
    dateSent: null,
    dateCompleted: null,
  };
}

/** 어디로 보낼지 가른다. 우리가 못 보내는 첨부는 조용히 버리지 않고 여기서 막는다 */
function partition(list: readonly SolapiMessage[]): {
  forSolapi: SolapiMessage[];
  forClawOps: Array<{ to: string; message: SolapiMessage }>;
} {
  const forSolapi: SolapiMessage[] = [];
  const forClawOps: Array<{ to: string; message: SolapiMessage }> = [];

  for (const message of list) {
    const type = upperType(message);
    if ((type !== '' && !OURS.has(type)) || hasVendorOptions(message)) {
      forSolapi.push(message);
      continue;
    }
    if (message.imageId !== undefined) {
      throw new SolapiBridgeError(
        'imageId 는 솔라피에 업로드된 파일 ID 라 ClawOps 로 전달할 수 없습니다. ' +
          '이미지 첨부가 필요하면 ClawOps 의 mediaUrl 로 직접 발송하십시오.',
      );
    }
    for (const to of recipientsOf(message.to)) forClawOps.push({ to, message });
  }
  return { forSolapi, forClawOps };
}

interface Plan {
  outgoing: SolapiMessage;
  source: SolapiMessage;
}

/**
 * 대체발송에 쓸 발신번호. 없으면 대체발송하지 않는다는 뜻이다.
 *
 * 솔라피 규칙 그대로 — `from` 이 있고 `disableSms` 가 true 가 아니면 "실패 시 문자로".
 * 이 판정이 두 곳에 있으면 갈린다. 실제로 예약발송 검증과 계획 수립이 다르게 답한 적이 있다.
 */
function fallbackFrom(message: SolapiMessage | undefined): string | undefined {
  const kakaoOptions = message?.kakaoOptions;
  if (!kakaoOptions || kakaoOptions.disableSms === true) return undefined;
  return message?.from;
}

/** ClawOps 가 거절한 건을 솔라피 실패 레코드 모양으로 옮긴다 */
function clawopsFailure(to: string, from: string, error: unknown): Failed {
  return {
    to: normalizePhone(to),
    from: normalizePhone(from),
    type: 'SMS',
    statusMessage: error instanceof Error ? error.message : String(error),
    country: '82',
    messageId: '',
    statusCode: CLAWOPS_FAILURE_STATUS_CODE,
    accountId: '',
  };
}

/**
 * 솔라피 의미를 그대로 읽는다.
 *   from 있음 + disableSms !== true  →  "실패하면 문자로 대체발송해 달라"
 * 실행 주체만 우리로 바뀌므로 카카오 옵션이 붙은 메시지에 한해
 *   ① from 을 뺀다 — 솔라피에 미등록된 번호면 알림톡 자체가 접수 거부된다
 *   ② disableSms 를 true 로 한다 — 솔라피가 중복으로 문자를 쏘지 않도록
 * RCS·NSA·FAX·VOICE 는 각자 발신번호와 옵션 체계가 따로 있어 손대지 않는다.
 */
function buildPlans(messages: readonly SolapiMessage[], fallbackEnabled: boolean): Plan[] {
  return messages.map((message) => {
    const kakaoOptions = message.kakaoOptions;
    // 손댈 수 없거나 손대면 안 되는 경우는 요청을 그대로 넘긴다.
    // from 을 빼고 disableSms 를 켜 놓고 우리도 안 보내면, 고객이 원래 쓰던
    // 솔라피 자체 대체발송까지 죽는다 — 있던 기능을 잃는 쪽이 제일 나쁘다
    //
    //   · fallback 을 껐다
    //   · 브랜드메시지(kakaoOptions.bms) — 같은 필드를 쓰는 다른 제품이라 대체발송 규칙이 다르다
    //   · customFields 가 10개(상태코드 1035)를 다 써서 마커를 심을 자리가 없다
    if (!kakaoOptions || !fallbackEnabled || kakaoOptions.bms) {
      return { outgoing: message, source: message };
    }
    const fields = message.customFields ?? {};
    const canMark = FALLBACK_MARKER_FIELD in fields || Object.keys(fields).length < 10;
    if (!canMark) return { outgoing: message, source: message };

    const { from: _from, ...rest } = message;

    // 스윕은 계정 전체를 훑으므로, 우리가 보낸 건임을 여기서 표시해 둔다.
    // 이 마커가 없으면 고객이 솔라피로 직접 보낸 알림톡까지 문자를 쏘게 된다.
    // 문구는 심지 않는다 — 발송 경로에 템플릿 조회를 넣으면 그만큼 느려진다.
    // 스윕이 조회한 자리에서 복원한다.
    //
    // mode 와 무관하게 심는다. 크론에서 sweepFailedAlimtalk() 를 부르는 구성도
    // 이 마커에 의존하는데, mode 로 게이트하면 그쪽이 조용히 0건만 훑는다
    let customFields = message.customFields;
    if (fallbackFrom(message) !== undefined) {
      customFields = { ...fields, [FALLBACK_MARKER_FIELD]: FALLBACK_MARKER_VALUE };
    }

    return {
      outgoing: {
        ...rest,
        ...(customFields ? { customFields } : {}),
        kakaoOptions: { ...kakaoOptions, disableSms: true },
      },
      source: message,
    };
  });
}

/**
 * 실패 건을 요청 계획에 되짚는다.
 * 같은 수신자에게 여러 건을 보낼 수 있으므로 수신자당 계획을 줄 세워 하나씩 소비하고,
 * solapi 가 하이픈을 지운 번호로 돌려주므로 양쪽 모두 정규화해서 비교한다.
 */
function matchFailures(
  plans: readonly Plan[],
  failures: readonly Failed[],
): Array<{ failure: Failed; plan?: Plan }> {
  const byRecipient = new Map<string, number[]>();
  plans.forEach((plan, index) => {
    for (const to of recipientsOf(plan.outgoing.to)) {
      const key = normalizePhone(to);
      const bucket = byRecipient.get(key);
      if (bucket) bucket.push(index);
      else byRecipient.set(key, [index]);
    }
  });

  return failures.map((failure) => {
    const index = byRecipient.get(normalizePhone(failure.to))?.shift();
    return { failure, plan: index === undefined ? undefined : plans[index] };
  });
}

function makeSend(
  options: ClawOpsMessageServiceOptions,
  fallbackConfig: EnabledFallback | undefined,
  templateCache: Map<string, Promise<string | undefined>>,
): SolapiMessageService['send'] {
  const fallbackEnabled = fallbackConfig !== undefined;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  /** 한 건을 ClawOps 로 보낸다. 실패해도 던지지 않고 결과로 알린다 */
  const viaClawOps = async (
    to: string,
    message: { from?: string; text?: string; subject?: string; type?: unknown },
    statusMessage = '정상 접수',
  ): Promise<{ ok: true; sent: Sent } | { ok: false; failed: Failed }> => {
    const from = normalizePhone(message.from ?? options.from);
    const type = clawopsType(message);
    try {
      const created = await options.clawops.messages.create({
        to: normalizePhone(to),
        from,
        body: message.text ?? '',
        type,
        subject: message.subject,
      });
      return {
        ok: true,
        sent: { messageId: created.messageId, statusCode: '2000', statusMessage },
      };
    } catch (error) {
      // 한 건이 막혀도 이미 보낸 건들의 기록을 잃지 않는다
      return {
        ok: false,
        failed: {
          to: normalizePhone(to),
          from,
          type: type.toUpperCase(),
          statusMessage: error instanceof Error ? error.message : String(error),
          country: '82',
          messageId: '',
          statusCode: CLAWOPS_FAILURE_STATUS_CODE,
          accountId: '',
        },
      };
    }
  };

  /** 알림톡 실패분을 문자로 대체발송한다. 문구 조회와 발송이 건마다 왕복이라 동시에 돌린다 */
  const runFallbacks = async (
    plans: readonly Plan[],
    failures: readonly Failed[],
    solapi: SolapiMessageService,
  ): Promise<{ sent: Sent[]; failed: Failed[]; replacement: number; failedCount: number }> => {
    const jobs = matchFailures(plans, failures);

    const deliveries = await mapWithConcurrency(jobs, concurrency, async (job) => {
      const from = fallbackFrom(job.plan?.source);
      if (from === undefined) return undefined;
      return deliverFallback({ source: job.plan!.source, to: job.failure.to, from }, solapi, {
        clawops: options.clawops,
        field: fallbackConfig?.field,
        cache: templateCache,
      });
    });

    // 콜백은 요청 순서대로 부른다 — 동시 실행 중에 부르면 순서가 뒤섞인다
    const sent: Sent[] = [];
    const failed: Failed[] = [];
    let replacement = 0;
    /** 대체발송을 시도했다가 ClawOps 가 거절한 건. 솔라피 실패는 이미 저쪽이 세므로 뺀다 */
    let failedCount = 0;

    deliveries.forEach((delivery, index) => {
      const { failure } = jobs[index]!;
      if (delivery === undefined) {
        failed.push(failure);
        return;
      }
      if (delivery.status === 'blocked') {
        fallbackConfig?.onBlocked?.({ to: failure.to, ...delivery.reason });
        failed.push(failure);
        return;
      }
      if (delivery.status === 'send_failed') {
        // 발송이 성공한 뒤에만 알린다. 먼저 부르면 ClawOps 가 거절한 건까지
        // '문자로 대체발송' 로그가 남아, 운영자가 도달했다고 믿는다
        failed.push(clawopsFailure(failure.to, options.from, delivery.error));
        failedCount += 1;
        return;
      }
      sent.push({
        messageId: delivery.messageId,
        statusCode: '2000',
        statusMessage: '정상 접수(대체발송)',
      });
      replacement += 1;
      fallbackConfig?.onFallback?.({
        to: failure.to,
        source: delivery.source,
        text: delivery.text,
      });
    });
    return { sent, failed, replacement, failedCount };
  };

  return async (messages, config) => {
    // 읽기만 하므로 복사하지 않는다
    const list: readonly SolapiMessage[] = Array.isArray(messages) ? messages : [messages];
    const { forSolapi, forClawOps } = partition(list);
    const sent: Sent[] = [];
    const failed: Failed[] = [];
    let replacement = 0;
    // 솔라피 집계에 더할 우리 몫. sent/failed 에는 솔라피 것도 섞여 길이로는 셀 수 없다
    let ourOk = 0;
    let ourFailed = 0;

    // 예약 발송처럼 우리가 못 지키는 설정은, 문자가 없어도 대체발송 대상이 있으면 막아야 한다.
    // 알림톡만 있는 배치라도 접수 실패가 나면 대체 문자가 '지금' 나가버린다
    const willFallback =
      fallbackEnabled && forSolapi.some((message) => fallbackFrom(message) !== undefined);
    if (forClawOps.length > 0 || willFallback) assertConfigSupported(config);

    if (forClawOps.length > 0) {
      for (const outcome of await mapWithConcurrency(forClawOps, concurrency, (item) =>
        viaClawOps(item.to, item.message),
      )) {
        if (outcome.ok) {
          sent.push(outcome.sent);
          ourOk += 1;
        } else {
          failed.push(outcome.failed);
          ourFailed += 1;
        }
      }
    }

    let base: GroupInfo | null = null;

    if (forSolapi.length > 0) {
      const solapi = options.solapi;
      if (!solapi) {
        throw new SolapiBridgeError(
          '알림톡·RCS 를 보내려면 solapi 인스턴스를 넘겨야 합니다. ' +
            'new ClawOpsMessageService({ solapi: new SolapiMessageService(key, secret), … })',
        );
      }

      const plans = buildPlans(forSolapi, fallbackEnabled);
      let solapiFailed: readonly Failed[] = [];
      try {
        const response = await solapi.send(
          plans.map((plan) => plan.outgoing) as RequestSendMessagesSchema,
          config,
        );
        base = response.groupInfo;
        sent.push(...(response.messageList ?? []));
        solapiFailed = response.failedMessageList;
      } catch (error) {
        if (!isMessageNotReceived(error)) throw error;
        solapiFailed = error.failedMessageList; // 전건 실패 — groupInfo 는 오지 않는다
      }

      if (solapiFailed.length > 0) {
        if (!fallbackEnabled) {
          failed.push(...solapiFailed);
        } else {
          const result = await runFallbacks(plans, solapiFailed, solapi);
          sent.push(...result.sent);
          failed.push(...result.failed);
          replacement += result.replacement;
          ourFailed += result.failedCount;
        }
      }
    }

    return {
      groupInfo: makeGroupInfo(base, { ok: ourOk, failed: ourFailed, replacement }),
      messageList: sent,
      failedMessageList: failed,
    };
  };
}

/**
 * 문자 전용 모드에서 Proxy 가 모든 키를 메서드로 취급하면 JS 의 기본 규약이 깨진다.
 * `then` 이 함수로 보이면 thenable 로 간주돼 async 함수에서 반환할 수조차 없다.
 */
const NON_METHOD_KEYS = new Set(['then', 'toJSON', 'inspect']);

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** 처리 집합 상한. 커서가 이미 대부분을 막으므로 이건 재갱신 대비 여유분이다 */
const PROCESSED_LIMIT = 10_000;

/**
 * 발송 실패(3XXX)를 주기적으로 되짚는 루프.
 *
 * 타이머는 `unref()` 해서 프로세스를 붙잡지 않는다 — 이 루프가 돈다는 이유로 서버가
 * 종료되지 않는 일은 없어야 한다.
 */
function startSweepLoop(
  options: ClawOpsMessageServiceOptions,
  sweep: EnabledFallback & { mode: 'sweep' },
  solapi: SolapiMessageService,
  templateCache: Map<string, Promise<string | undefined>>,
): void {
  const processed = new Set<string>();
  let cursor = sweep.initialCursor;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // 한 주기가 길어져도 겹쳐 돌지 않는다
    running = true;
    try {
      const result = await sweepFailedAlimtalk({
        clawops: options.clawops,
        solapi,
        from: options.from,
        cursor,
        lookbackMs: sweep.lookbackMs,
        on: sweep.on,
        types: sweep.types,
        fallbackField: sweep.field,
        concurrency: options.concurrency,
        templateCache,
        skip: (messageId) => processed.has(messageId),
        onFallback: sweep.onFallback,
        onBlocked: sweep.onBlocked,
      });

      cursor = result.cursor;
      for (const messageId of result.processed) processed.add(messageId);
      if (processed.size > PROCESSED_LIMIT) {
        // Set 은 삽입 순서를 지키므로 오래된 절반을 버린다
        for (const messageId of [...processed].slice(0, processed.size - PROCESSED_LIMIT / 2)) {
          processed.delete(messageId);
        }
      }
      // 빈 스윕까지 알리면 커서를 외부에 저장하는 쪽이 하루 288번 같은 값을 다시 쓴다
      if (result.scanned > 0) sweep.onCursor?.(result.cursor);
    } catch (error) {
      // 스윕 실패가 프로세스를 죽이지 않는다. 커서를 옮기지 않았으므로 다음 주기가 같은 구간을 다시 본다
      sweep.onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), sweep.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

function create(options: ClawOpsMessageServiceOptions): SolapiMessageService {
  const fallbackConfig = normalizeFallback(options.fallback);
  const templateCache = new Map<string, Promise<string | undefined>>();
  const send = makeSend(options, fallbackConfig, templateCache);

  if (fallbackConfig?.mode === 'sweep') {
    if (!options.solapi) {
      throw new SolapiBridgeError(
        "mode: 'sweep' 은 솔라피 리포트를 훑는 기능이라 solapi 인스턴스가 필요합니다. " +
          '문자만 보낸다면 이 설정은 할 일이 없습니다.',
      );
    }
    startSweepLoop(options, fallbackConfig, options.solapi, templateCache);
  }

  // 주입된 solapi 인스턴스를 감싼다. 원본은 수정하지 않는다.
  // send 만 우리가 가로채고 나머지 메서드는 그대로 흘려보낸다.
  //
  // 핸들러는 생성 시점에 한 번 고른다 — solapi 유무는 객체 수명 동안 바뀌지 않으므로
  // 프로퍼티 접근마다 분기할 이유가 없고, 문자 전용 모드의 특수 처리도 한쪽에만 모인다
  const solapi = options.solapi;
  const handler: ProxyHandler<SolapiMessageService> = solapi
    ? {
        get(instance, property) {
          if (property === 'send') return send;
          const value = Reflect.get(instance, property, instance);
          return typeof value === 'function' ? value.bind(instance) : value;
        },
      }
    : {
        get(_instance, property) {
          if (property === 'send') return send;
          if (typeof property === 'symbol' || NON_METHOD_KEYS.has(property)) return undefined;
          // Object.prototype 의 것들은 JS 가 답하게 둔다. 막으면 hasOwnProperty 같은 것이 깨진다
          if (property in Object.prototype) {
            return Reflect.get(Object.prototype, property) as unknown;
          }
          return () => {
            throw new SolapiBridgeError(
              `${String(property)}() 는 솔라피 기능입니다. solapi 인스턴스를 넘겨주세요.`,
            );
          };
        },
      };

  return new Proxy((solapi ?? {}) as SolapiMessageService, handler);
}

interface ClawOpsMessageServiceConstructor {
  /** solapi 를 넘기면 SolapiMessageService 와 완전히 동일한 타입 */
  new (
    options: ClawOpsMessageServiceOptions & { solapi: SolapiMessageService },
  ): SolapiMessageService;
  /** 안 넘기면 문자 전용. 솔라피 기능은 타입에 나타나지 않는다 */
  new (options: ClawOpsMessageServiceOptions & { solapi?: undefined }): ClawOpsTextOnlyService;
  /** 있는지 런타임에만 아는 경우. 두 경우 모두에서 안전한 문자 전용 타입을 준다 */
  new (options: ClawOpsMessageServiceOptions): ClawOpsTextOnlyService;
}

/**
 * 솔라피 코드를 그대로 두고 문자만 ClawOps 로 보낸다.
 *
 * `new` 의 결과 타입은 `SolapiMessageService` 그 자체라 기존 코드의 타입 자리에 그대로 들어간다.
 */
export const ClawOpsMessageService = function (
  this: unknown,
  options: ClawOpsMessageServiceOptions,
) {
  return create(options);
} as unknown as ClawOpsMessageServiceConstructor;
