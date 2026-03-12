import { z } from 'zod';

export const MessageSchema = z
  .object({
    messageId: z.string(),
    status: z.enum(['queued', 'sending', 'sent', 'failed', 'received']),
    type: z.enum(['sms', 'lms', 'mms', 'rcs', 'kakao']),
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
