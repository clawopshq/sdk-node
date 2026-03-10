import { z } from 'zod';

export const PhoneNumberSchema = z
  .object({
    number: z.string(),
    source: z.string().nullable().optional(),
    webhookUrl: z.string().nullable().optional(),
    webhookMethod: z.enum(['POST', 'GET']).nullable().optional(),
    createdAt: z.string().nullable().optional(),
  })
  .passthrough();

export type PhoneNumber = z.infer<typeof PhoneNumberSchema>;
export type NumberListItem = PhoneNumber;
export type NumberUpdateResponse = PhoneNumber;
