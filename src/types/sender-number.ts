import { z } from 'zod';

/**
 * 문자 발신번호(clawops#1489). 문자는 등록해 승인된 발신번호로만 보낼 수 있습니다.
 *
 * `type`·`verificationMethod`·`status` 는 enum 으로 좁히지 않습니다 — 서버가 값을 늘려도
 * 목록 조회가 파싱 단계에서 깨지지 않게 하려는 것입니다(`BlockedRecipient.channel` 과 같은 이유).
 */
export const SenderNumberSchema = z
  .object({
    /** 발신번호 id. 삭제할 때 씁니다. */
    id: z.string(),
    /** 발신번호(숫자만). */
    number: z.string(),
    /** `'070'` | `'representative'`(대표번호) | `'mobile'`(이동전화) */
    type: z.string(),
    /** `'own_provisioned'`(ClawOps 개통) | `'identity_verified'`(본인확인 이동전화) | `'usage_cert_ars'`(다른 통신사 대표번호) */
    verificationMethod: z.string(),
    /** `'approved'` = 발송에 쓸 수 있음, `'pending'` = 승인 대기 */
    status: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export type SenderNumber = z.infer<typeof SenderNumberSchema>;

/** 등록하지 않았지만 유예 기간이라 `expiresAt` 전까지 보낼 수 있는 번호. */
export const SenderNumberGraceSchema = z
  .object({
    number: z.string(),
    expiresAt: z.string(),
  })
  .passthrough();

export type SenderNumberGrace = z.infer<typeof SenderNumberGraceSchema>;

/**
 * 070번호·대표번호 회선 수 한도. 계정이 아니라 명의 기준이라 같은 명의의 다른 계정 등록분도 셉니다.
 * `limit` 이 `null` 이면 한도가 아직 정해지지 않았습니다(법인 종사자 수 증빙 전).
 */
export const SenderNumberLimitSchema = z
  .object({
    used: z.number(),
    limit: z.number().nullable(),
    reached: z.boolean(),
  })
  .passthrough();

export type SenderNumberLimit = z.infer<typeof SenderNumberLimitSchema>;

export const SenderNumberListSchema = z
  .object({
    senderNumbers: z.array(SenderNumberSchema),
    grace: z.array(SenderNumberGraceSchema),
    /** 명의를 확인할 수 없으면 `null`. */
    limit: SenderNumberLimitSchema.nullable(),
  })
  .passthrough();

export type SenderNumberList = z.infer<typeof SenderNumberListSchema>;

/**
 * 번호 발급 응답의 문자 발신번호 자동 등록 결과. `registered` 가 `false` 여도 번호 발급은 성공입니다 —
 * 그 번호로는 아직 문자를 보낼 수 없고, `reason` 을 해결한 뒤 `senderNumbers.create()` 로 등록합니다.
 *
 * `reason` 예: `sender_number_limit_reached`(한도 도달), `sender_number_limit_unknown`(한도 미정),
 * `sender_number_holder_unresolved`(명의 확인 불가), `actor_unknown`, `unexpected`(일시 오류).
 */
export const SmsSenderRegistrationSchema = z
  .object({
    registered: z.boolean(),
    senderNumberId: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type SmsSenderRegistration = z.infer<typeof SmsSenderRegistrationSchema>;
