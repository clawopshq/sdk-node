import { z } from 'zod';

export const CallSchema = z
  .object({
    callId: z.string(),
    status: z.enum(['queued', 'ringing', 'in-progress', 'completed', 'failed']),
    to: z.string(),
    from: z.string(),
    direction: z.enum(['outbound', 'inbound']),
    duration: z.number().nullable().optional(),
    accountId: z.string(),
    dateCreated: z.string(),
    dateUpdated: z.string().nullable().optional(),
  })
  .passthrough();

export type Call = z.infer<typeof CallSchema>;

export const CallControlResponseSchema = z
  .object({
    callId: z.string(),
    status: z.string(),
  })
  .passthrough();

export type CallControlResponse = z.infer<typeof CallControlResponseSchema>;
