import { z } from 'zod';

/**
 * 통화 요약 상태. status 에 따라 채워지는 필드가 다름:
 * - "completed": callId, resultJson, provider, model, promptVersion, schemaVersion, updatedAt
 * - "pending":   이외 필드 비어있음
 * - "failed":    failedReason
 * - "not_requested": 통화는 있지만 요약 row 가 아직 없음
 */
export const SummaryStatusSchema = z
  .object({
    status: z.enum(['completed', 'pending', 'failed', 'not_requested']),
    callId: z.string().optional(),
    resultJson: z.record(z.string(), z.unknown()).nullable().optional(),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    promptVersion: z.string().nullable().optional(),
    schemaVersion: z.string().nullable().optional(),
    failedReason: z.string().nullable().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export type SummaryStatus = z.infer<typeof SummaryStatusSchema>;
