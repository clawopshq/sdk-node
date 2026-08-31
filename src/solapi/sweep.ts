import type { SolapiMessageService } from 'solapi';
import type { ClawOps } from '../client.js';
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from './_concurrency.js';
import { deliverFallback } from './_fallback.js';
import type { FallbackInput, FallbackSource, FallbackText } from './fallback-text.js';

/** 발송 시 심는 마커. 이 값이 있는 건만 대체발송 후보다 */
export const FALLBACK_MARKER_FIELD = 'clawopsFallback';
export const FALLBACK_MARKER_VALUE = '1';

/**
 * 기본은 **모든 발송 실패(3XXX)** 다. `on` 을 주지 않으면 3XXX 를 전부 대체발송한다.
 *
 * 코드를 골라 담지 않는다. 알림톡이라고 31xx 만 오는 게 아니기 때문이다 — 실측에서
 * 알림톡 건에 `3058`(전송경로 없음)이 돌아왔다. 목록을 추리면 그렇게 새는 코드가
 * 조용히 미발송이 된다. 놓치는 쪽보다 보내는 쪽을 기본으로 둔다.
 *
 * 대신 **덮으면 안 되는 코드가 섞여 있다.** 아래를 `except` 로 빼는 것을 권한다.
 */
export const RECOMMENDED_EXCLUDED_CODES = [
  // 수신거부 — 문자로 대체하면 거부한 사람에게 보내는 것이 된다
  '3061',
  // 스팸·발신번호 변작 차단 — 막힌 발송을 문자로 우회하는 셈이 된다
  '3054',
  '3055',
  '3059',
  '3112',
  '3113',
  // 설정 오류 — 전건이 실패한다. 문자가 덮으면 알림톡이 깨진 걸 몇 달간 모르고,
  // 단가도 알림톡에서 문자로 조용히 올라간다
  '3013',
  '3101',
  '3103',
  '3105',
  '3106',
  '3109',
  '3117',
  // 발송 가능 시간이 아님 — 문자로 대체하면 야간 발송이 된다
  '3108',
] as const;

/**
 * 훑을 메시지 타입. 기본은 알림톡만이다.
 *
 * 발송 시 마커는 `kakaoOptions` 가 붙은 모든 메시지(친구톡 포함)에 심으므로,
 * 친구톡까지 대체발송하려면 `['ATA', 'CTA', 'CTI']` 로 넓혀야 한다.
 * 넓히면 그만큼 조회가 늘어난다.
 */
export const DEFAULT_SWEEP_TYPES = ['ATA'] as const satisfies readonly SweepMessageType[];

/**
 * 발송 실패 코드. 이것만 실패로 본다.
 *
 * "성공·진행중이 아니면 실패" 로 뒤집어 쓰면 벤더가 새 정보성 코드를 추가하는 순간
 * 그 코드를 단 모든 건이 '대체발송 못 함' 으로 사람을 깨운다. 모르는 값은 가만히 둔다.
 */
const DELIVERY_FAILURE = /^3\d{3}$/;
/** 이통사 접수 — 아직 결과가 아니다 */
const IN_FLIGHT_CODE = '3000';

const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

/** 다음 스윕이 어디서부터 볼지. 프로세스 밖에 저장할 수 있게 직렬화 가능한 값만 담는다 */
export interface SweepCursor {
  /** 마지막으로 본 갱신 시각 (ISO 8601) */
  updatedAt: string;
  /** 그 시각과 같은 messageId 들. 경계에서 같은 건을 두 번 집지 않기 위해 */
  seen: readonly string[];
}

export interface SweepFallbackEvent {
  messageId: string;
  to: string;
  statusCode: string;
  source: FallbackSource;
  text: string;
}

export type SweepBlockedEvent = {
  messageId: string;
  to: string;
  statusCode: string;
} & (
  | Extract<FallbackText, { ok: false }>
  /** 실패했지만 대체발송 대상 코드가 아니다 — 설정 오류·야간 등 */
  | { ok: false; reason: 'code_not_eligible' }
  /** 문구는 만들었는데 ClawOps 가 거절했다. 다음 스윕이 다시 시도한다 */
  | { ok: false; reason: 'send_rejected' }
);

export interface SweepOptions {
  clawops: ClawOps;
  solapi: SolapiMessageService;
  /** 대체발송에 쓸 기본 발신번호. 조회 결과의 from 은 솔라피 발신번호라 쓰지 않는다 */
  from: string;
  /** 없으면 `lookbackMs` 만큼 거슬러 본다 */
  cursor?: SweepCursor;
  lookbackMs?: number;
  /** 대체발송할 상태코드. 주지 않으면 **모든 3XXX** 가 대상이다 */
  on?: readonly string[];
  /**
   * 대상에서 뺄 상태코드. `on` 으로 좁힌 뒤 여기서 다시 뺀다.
   * 빼려는 코드는 `RECOMMENDED_EXCLUDED_CODES` 를 그대로 넘기면 된다.
   */
  except?: readonly string[];
  /** 훑을 메시지 타입. 기본 `DEFAULT_SWEEP_TYPES` (알림톡만) */
  types?: readonly SweepMessageType[];
  fallbackField?: string;
  concurrency?: number;
  /** 이미 처리한 건을 건너뛴다. 커서가 못 막는 재갱신을 여기서 막는다 */
  skip?: (messageId: string) => boolean;
  /** 템플릿 본문 캐시. 스윕 간 재사용하면 조회가 줄어든다 */
  templateCache?: Map<string, Promise<string | undefined>>;
  onFallback?: (event: SweepFallbackEvent) => void;
  onBlocked?: (event: SweepBlockedEvent) => void;
}

export interface SweepResult {
  /** 다음 호출에 그대로 넘긴다 */
  cursor: SweepCursor;
  /** 조회한 총 건수 */
  scanned: number;
  /** 대체발송한 건수 */
  sent: number;
  /** 문구를 만들지 못해 보내지 못한 건수 */
  blocked: number;
  /**
   * 페이지 상한에 걸려 구간을 다 못 봤다. 이때는 커서를 옮기지 않아 다음 스윕이 같은 곳을
   * 다시 본다 — 물량이 계속 상한을 넘으면 주기를 줄이거나 lookback 을 좁혀야 한다
   */
  truncated: boolean;
  /** 이번에 대체발송한 messageId. 호출자가 처리 집합에 넣는다 */
  processed: string[];
}

/** 조회 API 가 실제로 받는 메시지 타입. 문자열로 두면 enum 을 벗어난 값이 런타임에야 터진다 */
type SweepMessageType = NonNullable<
  NonNullable<Parameters<SolapiMessageService['getMessages']>[0]>['type']
>;

/** 조회 응답 한 건. solapi 의 storedMessage 중 우리가 쓰는 필드만 */
interface StoredMessage extends FallbackInput {
  messageId?: string;
  statusCode?: string | null;
  to?: string | readonly string[];
  dateCreated?: string;
  dateUpdated?: string;
}

interface GetMessagesResponse {
  messageList?: Record<string, StoredMessage>;
  nextKey?: string | null;
}

const firstRecipient = (to: StoredMessage['to']): string | undefined =>
  Array.isArray(to) ? to[0] : (to as string | undefined);

const timeOf = (row: StoredMessage): string | undefined => row.dateUpdated ?? row.dateCreated;

/**
 * 알림톡 발송 실패(3XXX)를 찾아 문자로 대체발송한다.
 *
 * 접수 실패(1XXX)는 `send()` 응답에서 바로 잡히지만, 수신자가 카카오톡을 쓰지 않거나
 * 알림톡을 차단한 경우(3104·3107)는 접수가 성공하고 **이통사 리포트에서만 판명된다.**
 * 그래서 주기적으로 되짚어야 한다.
 *
 * 발송 시 심은 마커가 있는 건만 대상이라, 고객이 솔라피로 직접 보낸 알림톡은 건드리지 않는다.
 */
export async function sweepFailedAlimtalk(options: SweepOptions): Promise<SweepResult> {
  // null 이면 3XXX 전부가 대상이다. 빈 Set 과 구별해야 한다 — `on: []` 는 '아무것도 안 함' 이다
  const targets = options.on ? new Set<string>(options.on) : null;
  const excluded = new Set<string>(options.except ?? []);
  const boundary = new Set(options.cursor?.seen ?? []);
  const templateCache = options.templateCache ?? new Map<string, Promise<string | undefined>>();

  const window = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const startDate = options.cursor
    ? new Date(options.cursor.updatedAt)
    : new Date(Date.now() - window);
  // 창을 한 번에 보는 폭으로 제한한다.
  // 상한에 걸려 커서를 유지할 때 endDate 만 계속 전진하면 창이 넓어지기만 해
  // 행 수가 영영 줄지 않는다 — 매 주기 50회씩 조회하며 진전이 0 인 상태가 된다
  const endDate = new Date(Math.min(Date.now(), startDate.getTime() + window));

  const candidates: StoredMessage[] = [];
  const ineligible: StoredMessage[] = [];
  let scanned = 0;
  let maxTime = startDate.getTime();
  // Set 이어야 한다 — 배열이면 경계에 걸린 id 를 매 스윕 다시 넣어 커서가 계속 부푼다
  let atMax = new Set(boundary);
  let truncated = false;

  for (const type of options.types ?? DEFAULT_SWEEP_TYPES) {
    let startKey: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = (await options.solapi.getMessages({
        type,
        dateType: 'UPDATED',
        startDate,
        endDate,
        limit: PAGE_SIZE,
        startKey,
      })) as GetMessagesResponse;

      const rows = Object.values(response.messageList ?? {});
      if (rows.length === 0) break;
      scanned += rows.length;

      for (const row of rows) {
        // 커서는 대상 여부와 무관하게 조회한 전체 기준으로 옮긴다.
        // 후보만 기준으로 삼으면 실패가 없는 구간에서 커서가 제자리에 멈춘다
        const at = timeOf(row);
        const id = row.messageId;
        if (at && id) {
          const time = new Date(at).getTime();
          if (time > maxTime) {
            maxTime = time;
            atMax = new Set([id]);
          } else if (time === maxTime) {
            atMax.add(id);
          }
        }

        if (!id || boundary.has(id)) continue;
        if (options.skip?.(id)) continue;
        if (row.customFields?.[FALLBACK_MARKER_FIELD] !== FALLBACK_MARKER_VALUE) continue;

        // 3XXX 가 아니면 아직 결과가 아니거나 우리가 모르는 상태다. 다음 스윕에서 다시 본다
        const code = String(row.statusCode ?? '');
        if (code === IN_FLIGHT_CODE || !DELIVERY_FAILURE.test(code)) continue;

        // 실패했는데 대체발송 대상이 아니면 조용히 넘기지 않는다.
        // auto 를 켠 고객은 "실패하면 문자가 간다"고 믿고 있고, 3105(미등록 템플릿) 같은
        // 설정 오류로 안 나갔다는 사실은 알아야 고칠 수 있다
        if ((targets !== null && !targets.has(code)) || excluded.has(code)) {
          ineligible.push(row);
          continue;
        }
        candidates.push(row);
      }

      startKey = response.nextKey ?? undefined;
      if (!startKey) break;
      // 상한에 걸렸는데 아직 남았다 — 구간을 다 못 봤으므로 커서를 옮기면 안 된다
      if (page === MAX_PAGES - 1) truncated = true;
    }
  }

  const deliveries = await mapWithConcurrency(
    candidates,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (row) => {
      const to = firstRecipient(row.to);
      if (to === undefined) return undefined;
      // 같은 알림톡 건은 몇 번을 다시 훑어도 문자가 두 번 나가지 않는다.
      // 커서가 비는 순간(재시작·경계)의 안전망이다.
      return deliverFallback(
        { source: row, to, from: options.from, idempotencyKey: `solapi:${row.messageId}` },
        options.solapi,
        { clawops: options.clawops, field: options.fallbackField, cache: templateCache },
      );
    },
  );

  // 콜백은 조회 순서대로 부른다 — 동시 실행 중에 부르면 순서가 뒤섞인다
  const processed: string[] = [];
  let blocked = 0;

  for (const row of ineligible) {
    blocked += 1;
    options.onBlocked?.({
      messageId: row.messageId ?? '',
      to: firstRecipient(row.to) ?? '',
      statusCode: String(row.statusCode ?? ''),
      ok: false,
      reason: 'code_not_eligible',
    });
  }

  deliveries.forEach((delivery, index) => {
    const row = candidates[index]!;
    const messageId = row.messageId ?? '';
    const to = firstRecipient(row.to) ?? '';
    const statusCode = String(row.statusCode ?? '');

    if (delivery === undefined) return;
    if (delivery.status !== 'sent') {
      blocked += 1;
      options.onBlocked?.(
        delivery.status === 'blocked'
          ? { messageId, to, statusCode, ...delivery.reason }
          : // 문구는 만들었는데 ClawOps 가 거절했다. 다음 스윕이 다시 시도하고,
            // 멱등키가 같아 중복 발송은 되지 않는다
            { messageId, to, statusCode, ok: false, reason: 'send_rejected' },
      );
      return;
    }
    processed.push(messageId);
    options.onFallback?.({
      messageId,
      to,
      statusCode,
      source: delivery.source,
      text: delivery.text,
    });
  });

  // 잘렸으면 커서를 그대로 둔다. 옮기면 못 본 구간을 영영 다시 안 본다
  const cursor: SweepCursor = truncated
    ? (options.cursor ?? { updatedAt: startDate.toISOString(), seen: [] })
    : { updatedAt: new Date(maxTime).toISOString(), seen: [...atMax] };

  return { cursor, scanned, sent: processed.length, blocked, truncated, processed };
}
