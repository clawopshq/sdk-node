import { z } from 'zod';

/**
 * 메시지 상태.
 *
 * ⚠️ 한때 여기 `'sending'` 이 있었는데 **서버가 한 번도 보낸 적 없는 값**이다 — 어휘를 손으로
 *    관리하면 없는 값이 들어오고 있는 값이 빠진다. 그래서 이 유니온은 자동완성용이고,
 *    검증은 하지 않는다.
 */
export type MessageStatus = 'queued' | 'sent' | 'failed' | 'received' | (string & {});

/**
 * 메시지 유형. `KakaoChannelStatus` 와 같은 이유로 **열린 유니온**이다 — 서버가 어휘를
 * 소유하므로 값이 하나 늘어도 조회는 살아 있어야 하고, 낡는 것은 자동완성뿐이다.
 */
export type MessageType =
  | 'sms'
  | 'lms'
  | 'mms'
  /** 카카오 알림톡. */
  | 'ata'
  /** 카카오 브랜드 메시지. */
  | 'bms'
  | (string & {});

export const MessageSchema = z
  .object({
    messageId: z.string(),
    status: z.string() as z.ZodType<MessageStatus>,
    /**
     * `'ata'`(알림톡)·`'bms'`(브랜드 메시지)는 카카오로 나간다. `body` 에는 템플릿에 변수를
     * 치환한 결과가 담기고, 버튼·아이템 리스트·강조 문구는 템플릿에 담긴 대로 발송되어
     * 이 값에는 담기지 않는다.
     *
     * ⛔ **닫힌 enum 으로 두지 않는다.** 어휘는 서버가 소유하므로, 유형이 하나 늘면 닫힌
     * enum 은 **목록을 통째로** 실패시킨다(`list()` 는 페이지를 한 번에 파싱한다). 실제로
     * 두 번 그렇게 터졌다 — `'ata'` 가 나왔을 때, 그리고 `'bms'` 가 나왔을 때.
     */
    type: z.string() as z.ZodType<MessageType>,
    to: z.string(),
    from: z.string(),
    body: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    numMedia: z.number(),
    mediaUrl: z.array(z.string()),
    direction: z.enum(['outbound', 'inbound']),
    accountId: z.string(),
    dateCreated: z.string(),
    dateUpdated: z.string().nullable().optional(),
  })
  .passthrough();

export type Message = z.infer<typeof MessageSchema>;
