import { z } from 'zod';

export const BlockedRecipientSchema = z
  .object({
    id: z.string(),
    /**
     * 수신거부한 상대. **채널과 무관하게 항상 이 칸에 들어갑니다** —
     * `call`·`message` 면 국내 표기로 정규화된 전화번호(예 `'01012345678'`),
     * `email` 이면 소문자로 정규화된 이메일 주소(예 `'kim@example.com'`).
     *
     * 채널이 늘어도 이 칸 하나만 읽으면 됩니다.
     */
    recipient: z.string(),
    /**
     * ⚠️ `email` 이 2026-09-07 에 추가됐습니다. 이 값을 **enum 으로 좁히지 마세요** —
     * 서버가 채널을 늘리면 옛 SDK 가 파싱 단계에서 통째로 실패합니다. 실제로 그 일이
     * 있었습니다: `['call','message']` 로 굳혀 둔 탓에, 이메일 항목이 하나라도 섞이면
     * 목록 조회 전체가 깨졌습니다. 알려진 값은 `BlockedChannel` 로 노출하되 파싱은
     * 열어 둡니다.
     */
    channel: z.string(),
    /** 지금 차단 중인지. 해제분도 이력으로 조회되므로 이 값으로 구분한다. */
    active: z.boolean(),
    source: z.string(),
    sourceRef: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdBy: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    unblockedAt: z.string().nullable().optional(),
    unblockedSource: z.string().nullable().optional(),
    unblockedBy: z.string().nullable().optional(),
    unblockedNote: z.string().nullable().optional(),
  })
  .passthrough();

export type BlockedRecipient = z.infer<typeof BlockedRecipientSchema>;

/**
 * 차단 채널. `call`=전화, `message`=문자(SMS/LMS/MMS 공통), `email`=이메일.
 *
 * 같은 상대라도 채널마다 별개 항목입니다 — 전화와 이메일을 모두 막으려면 두 번 등록합니다.
 *
 * ⚠️ 응답의 `channel` 은 `string` 입니다(위 참조). 이 타입은 **요청을 쓸 때의 도움말**이고,
 * `(string & {})` 를 유니온에 두어 서버가 새 채널을 내놔도 타입이 막지 않게 했습니다.
 */
export type BlockedChannel = 'call' | 'message' | 'email' | (string & {});

export type BlockedRecipientStatus = 'active' | 'released' | 'all';

/**
 * 접수 경로. 공개 API 로 등록하면 이 넷 중 하나입니다.
 *
 * ⚠️ 응답에는 **여기 없는 값도 옵니다** — `ars`(ARS 수신거부 9번), `sms`(문자 회신) 처럼
 * 내부 접수 경로로 들어온 항목이 그렇습니다. 그래서 응답의 `source` 는 `string` 입니다.
 */
export type BlockedRecipientSource = 'api' | 'console' | 'import' | 'agent';
