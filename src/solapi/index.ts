import type {
  SolapiMessageService,
  RequestSendMessagesSchema,
  SendRequestConfigSchema,
  DetailGroupMessageResponse,
} from 'solapi';
import type { ClawOps } from '../client.js';
import { SolapiBridgeError } from '../error.js';
import {
  resolveFallbackText,
  upperType,
  type FallbackSource,
  type FallbackText,
  type SolapiMessage,
} from './fallback-text.js';

export {
  resolveFallbackText,
  DEFAULT_FALLBACK_FIELD,
  type FallbackSource,
  type FallbackText,
  type SolapiMessage,
} from './fallback-text.js';
export { SolapiBridgeError } from '../error.js';

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
 * SMS 본문 상한(byte, UTF-8).
 * 서버의 판정 기준(`app/src/services/messages.ts` 의 `SMS_MAX_BYTES`)과 같아야 한다.
 * 어긋나면 우리가 sms 라고 보낸 건이 서버에서 `body_too_long` 으로 거절된다.
 */
const SMS_MAX_BYTES = 200;

/** 한 번에 띄우는 ClawOps 요청 수. 솔라피의 배치 한 번이 우리에겐 요청 N 번이 된다 */
const DEFAULT_CONCURRENCY = 10;

/** solapi 는 phoneNumberSchema 로 하이픈을 제거한다. 응답과 맞추려면 같은 규칙이 필요하다 */
const normalizePhone = (value: string): string => value.replace(/-/g, '');

const recipientsOf = (to: string | readonly string[]): readonly string[] =>
  Array.isArray(to) ? to : [to as string];

/** 우리가 접수하지 못한 건임을 알리는 코드. 솔라피 코드 체계와 겹치지 않는다 */
export const CLAWOPS_FAILURE_STATUS_CODE = 'CLAWOPS';

export interface FallbackEvent {
  to: string;
  source: FallbackSource;
  text: string;
}

export type FallbackBlockedEvent = { to: string } & Extract<FallbackText, { ok: false }>;

export interface ClawOpsMessageServiceOptions {
  /** ClawOps 클라이언트 */
  clawops: ClawOps;
  /** 문자 기본 발신번호. ClawOps 에 등록된 번호여야 한다 */
  from: string;
  /** 알림톡·RCS 등을 계속 쓸 때 넘긴다. 없으면 문자 전용 모드 */
  solapi?: SolapiMessageService;
  /** 알림톡 실패 시 문자로 대체발송. 기본 true */
  fallback?: boolean;
  /** 대체 문구를 읽어올 customFields 키 */
  fallbackField?: string;
  /** 동시에 띄우는 ClawOps 요청 수. 기본 10 */
  concurrency?: number;
  /** 대체발송이 일어날 때마다 알린다 */
  onFallback?: (event: FallbackEvent) => void;
  /** 문구를 만들지 못해 대체발송을 못 했을 때 알린다 */
  onBlocked?: (event: FallbackBlockedEvent) => void;
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
 * ClawOps 로 보낼 때의 메시지 타입.
 * 명시된 sms/lms 는 그대로 존중하고, 그 외에는 서버와 같은 규칙으로 정한다.
 */
function clawopsType(message: { type?: unknown; text?: string; subject?: string }): 'sms' | 'lms' {
  const type = upperType(message);
  if (type === 'SMS') return 'sms';
  if (type === 'LMS') return 'lms';
  if (message.subject !== undefined && message.subject !== '') return 'lms';
  return Buffer.byteLength(message.text ?? '', 'utf8') > SMS_MAX_BYTES ? 'lms' : 'sms';
}

/**
 * 순서를 지키면서 동시 요청 수를 제한한다.
 * 배치를 끊어 기다리면 한 건의 재시도가 같은 배치 전체를 붙잡으므로 워커가 계속 당겨 쓴다.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
  const registered = {
    total: counts.ok + counts.failed,
    registeredSuccess: counts.ok,
    registeredFailed: counts.failed,
  };

  if (base) {
    // 발송 단계 집계(sentTotal·sentSuccess·sentPending·refund)는 솔라피만 아는 값이라 보존하고,
    // 접수 집계만 우리가 보낸 문자까지 합쳐 다시 센다. 통째로 덮으면 솔라피 수치가 0 이 된다
    return {
      ...base,
      count: {
        ...base.count,
        ...registered,
        sentReplacement: base.count.sentReplacement + counts.replacement,
      },
    };
  }

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
    if (type !== '' && !OURS.has(type)) {
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
  /** 대체발송에 쓸 발신번호. 없으면 대체발송하지 않는다는 뜻이다 */
  fallbackFrom?: string;
  source: SolapiMessage;
}

/**
 * 솔라피 의미를 그대로 읽는다.
 *   from 있음 + disableSms !== true  →  "실패하면 문자로 대체발송해 달라"
 * 실행 주체만 우리로 바뀌므로 카카오 옵션이 붙은 메시지에 한해
 *   ① from 을 뺀다 — 솔라피에 미등록된 번호면 알림톡 자체가 접수 거부된다
 *   ② disableSms 를 true 로 한다 — 솔라피가 중복으로 문자를 쏘지 않도록
 * RCS·NSA·FAX·VOICE 는 각자 발신번호와 옵션 체계가 따로 있어 손대지 않는다.
 */
function buildPlans(messages: readonly SolapiMessage[]): Plan[] {
  return messages.map((message) => {
    const kakaoOptions = message.kakaoOptions;
    if (!kakaoOptions) return { outgoing: message, source: message };

    const { from, ...rest } = message;
    return {
      outgoing: { ...rest, kakaoOptions: { ...kakaoOptions, disableSms: true } },
      fallbackFrom: kakaoOptions.disableSms === true ? undefined : from,
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
): Array<Plan | undefined> {
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
    return index === undefined ? undefined : plans[index];
  });
}

function makeSend(options: ClawOpsMessageServiceOptions): SolapiMessageService['send'] {
  const fallbackEnabled = options.fallback ?? true;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const templateCache = new Map<string, Promise<string | undefined>>();

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
  ): Promise<{ sent: Sent[]; failed: Failed[]; replacement: number }> => {
    const matched = matchFailures(plans, failures);
    const jobs = failures.map((failure, index) => ({ failure, plan: matched[index] }));

    const outcomes = await mapWithConcurrency(jobs, concurrency, async (job) => {
      if (!job.plan?.fallbackFrom) return { kind: 'skipped' } as const;
      const resolved = await resolveFallbackText(job.plan.source, solapi, {
        field: options.fallbackField,
        cache: templateCache,
      });
      if (!resolved.ok) return { kind: 'blocked', resolved } as const;
      const outcome = await viaClawOps(
        job.failure.to,
        { from: job.plan.fallbackFrom, text: resolved.text, subject: job.plan.source.subject },
        '정상 접수(대체발송)',
      );
      return { kind: 'delivered', resolved, outcome } as const;
    });

    // 콜백은 요청 순서대로 부른다 — 동시 실행 중에 부르면 순서가 뒤섞인다
    const sent: Sent[] = [];
    const failed: Failed[] = [];
    let replacement = 0;
    outcomes.forEach((outcome, index) => {
      const { failure } = jobs[index]!;
      if (outcome.kind === 'skipped') {
        failed.push(failure);
        return;
      }
      if (outcome.kind === 'blocked') {
        options.onBlocked?.({ to: failure.to, ...outcome.resolved });
        failed.push(failure);
        return;
      }
      options.onFallback?.({
        to: failure.to,
        source: outcome.resolved.source,
        text: outcome.resolved.text,
      });
      if (outcome.outcome.ok) {
        sent.push(outcome.outcome.sent);
        replacement += 1;
      } else {
        failed.push(outcome.outcome.failed);
      }
    });
    return { sent, failed, replacement };
  };

  return async (messages, config) => {
    const list: SolapiMessage[] = Array.isArray(messages) ? [...messages] : [messages];
    const { forSolapi, forClawOps } = partition(list);
    const sent: Sent[] = [];
    const failed: Failed[] = [];
    let replacement = 0;

    if (forClawOps.length > 0) {
      assertConfigSupported(config);
      for (const outcome of await mapWithConcurrency(forClawOps, concurrency, (item) =>
        viaClawOps(item.to, item.message),
      )) {
        if (outcome.ok) sent.push(outcome.sent);
        else failed.push(outcome.failed);
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

      const plans = buildPlans(forSolapi);
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
        }
      }
    }

    return {
      groupInfo: makeGroupInfo(base, { ok: sent.length, failed: failed.length, replacement }),
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

function create(options: ClawOpsMessageServiceOptions): SolapiMessageService {
  const send = makeSend(options);

  // 주입된 solapi 인스턴스를 감싼다. 원본은 수정하지 않는다.
  // send 만 우리가 가로채고 나머지 메서드는 그대로 흘려보낸다.
  const target = (options.solapi ?? {}) as SolapiMessageService;
  return new Proxy(target, {
    get(instance, property) {
      if (property === 'send') return send;
      if (!options.solapi) {
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
      }
      const value = Reflect.get(instance, property, instance);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
  });
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
