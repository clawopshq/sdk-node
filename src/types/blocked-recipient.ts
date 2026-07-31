import { z } from 'zod';

export const BlockedRecipientSchema = z
  .object({
    id: z.string(),
    /** 국내 표기로 정규화된 번호 (예 '01012345678'). */
    number: z.string(),
    channel: z.enum(['call', 'message']),
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
export type BlockedChannel = BlockedRecipient['channel'];
export type BlockedRecipientStatus = 'active' | 'released' | 'all';
export type BlockedRecipientSource = 'api' | 'console' | 'import';
