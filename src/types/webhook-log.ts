import { z } from 'zod';

export const WebhookLogSchema = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    event: z.string(),
    requestUrl: z.string(),
    requestPayload: z.record(z.unknown()),
    responseStatus: z.number().nullable().optional(),
    responseBody: z.string().nullable().optional(),
    responseTimeMs: z.number().nullable().optional(),
    status: z.enum(['pending', 'delivered', 'failed']),
    attempt: z.number(),
    maxAttempts: z.number(),
    createdAt: z.string(),
    completedAt: z.string().nullable().optional(),
  })
  .passthrough();

export type WebhookLog = z.infer<typeof WebhookLogSchema>;
