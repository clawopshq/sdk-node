import type { SolapiMessageService } from 'solapi';
import type { ClawOps } from '../client.js';
import { clawopsType, normalizePhone } from './_message-type.js';
import {
  resolveFallbackText,
  type FallbackInput,
  type FallbackSource,
  type FallbackText,
} from './fallback-text.js';

export type BlockedReason = Extract<FallbackText, { ok: false }>;

/**
 * 대체발송 한 건의 결말.
 *
 * 접수 실패 경로(`send()` 안)와 발송 실패 경로(스윕)가 같은 일을 하므로 여기서 한 번만 정의한다.
 * 두 곳에 복사해 두면 한쪽에만 가드가 붙는 일이 실제로 벌어진다.
 */
export type FallbackDelivery =
  /** 문구를 만들지 못했다 */
  | { status: 'blocked'; reason: BlockedReason }
  /** 문자로 나갔다 */
  | { status: 'sent'; source: FallbackSource; text: string; messageId: string }
  /** 문구는 만들었지만 ClawOps 가 거절했다 */
  | { status: 'send_failed'; source: FallbackSource; text: string; error: unknown };

export interface FallbackContext {
  clawops: ClawOps;
  /** 대체 문구를 읽어올 customFields 키 */
  field?: string;
  /** 템플릿 본문 캐시 */
  cache: Map<string, Promise<string | undefined>>;
}

export interface FallbackRequest {
  /** 문구를 복원할 원본. 발송 요청이든 조회된 메시지든 상관없다 */
  source: FallbackInput & { subject?: string | null };
  to: string;
  from: string;
  /** 같은 건을 다시 보내지 않도록. 스윕처럼 재실행되는 경로만 채운다 */
  idempotencyKey?: string;
}

/**
 * 문구를 복원해 문자 한 건을 보낸다.
 *
 * **두 단계 모두 이 안에서 격리한다.** 밖으로 던지면 호출자가 배치 단위로 실패하는데,
 * 그 시점엔 이미 다른 건이 나가 있어 기록을 잃고 재시도하면 중복 발송이 된다.
 * 스윕에서는 더 나쁘다 — 한 건이 던지면 커서가 안 옮겨져 다음 주기가 같은 건을 다시 만나고,
 * 대체발송이 영영 진행되지 않는다.
 */
export async function deliverFallback(
  request: FallbackRequest,
  solapi: SolapiMessageService,
  context: FallbackContext,
): Promise<FallbackDelivery> {
  let resolved: FallbackText;
  try {
    resolved = await resolveFallbackText(request.source, solapi, {
      field: context.field,
      cache: context.cache,
    });
  } catch {
    resolved = { ok: false, reason: 'no_template_content', source: 'template' };
  }
  if (!resolved.ok) return { status: 'blocked', reason: resolved };

  const subject = request.source.subject ?? undefined;
  try {
    const created = await context.clawops.messages.create({
      to: normalizePhone(request.to),
      from: normalizePhone(request.from),
      body: resolved.text,
      type: clawopsType({ text: resolved.text, subject }),
      subject,
      idempotencyKey: request.idempotencyKey,
    });
    return {
      status: 'sent',
      source: resolved.source,
      text: resolved.text,
      messageId: created.messageId,
    };
  } catch (error) {
    return { status: 'send_failed', source: resolved.source, text: resolved.text, error };
  }
}
