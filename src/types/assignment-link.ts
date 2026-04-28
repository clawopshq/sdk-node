import { z } from 'zod';

export const AssignmentLinkAssignmentSchema = z
  .object({
    number: z.string(),
    name: z.string().nullable().optional(),
    consumedAt: z.string(),
    releasedAt: z.string().nullable().optional(),
  })
  .passthrough();

export const AssignmentLinkSchema = z
  .object({
    linkId: z.string(),
    url: z.string(),
    status: z.enum(['pending', 'consumed', 'expired', 'revoked']),
    createdAt: z.string(),
    expiresAt: z.string(),
    consumedAt: z.string().nullable().optional(),
    webhookUrl: z.string().nullable().optional(),
    webhookMethod: z.enum(['POST', 'GET']).nullable().optional(),
    note: z.string().nullable().optional(),
    assignment: AssignmentLinkAssignmentSchema.nullable().optional(),
  })
  .passthrough();

export const AssignmentLinkCreateResponseSchema = z
  .object({
    token: z.string(),
    url: z.string(),
    expiresAt: z.string(),
  })
  .passthrough();

export type AssignmentLinkAssignment = z.infer<typeof AssignmentLinkAssignmentSchema>;
export type AssignmentLink = z.infer<typeof AssignmentLinkSchema>;
export type AssignmentLinkCreateResponse = z.infer<typeof AssignmentLinkCreateResponseSchema>;
export type AssignmentLinkStatus = AssignmentLink['status'];
