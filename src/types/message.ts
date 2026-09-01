import { z } from 'zod';

export const MessageSchema = z
  .object({
    messageId: z.string(),
    status: z.enum(['queued', 'sending', 'sent', 'failed', 'received']),
    /**
     * `'ata'` 는 카카오 알림톡이다. `body` 에는 템플릿에 변수를 치환한 결과가 담기고,
     * 버튼·아이템 리스트·강조 문구는 템플릿에 검수된 대로 발송되어 이 값에는 담기지 않는다.
     */
    type: z.enum(['sms', 'lms', 'mms', 'rcs', 'ata']),
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
