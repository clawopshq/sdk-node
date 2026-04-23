import { z } from 'zod';

export const TranscriptSegmentSchema = z
  .object({
    speaker: z.enum(['CUSTOMER', 'AGENT']),
    start: z.number(),
    end: z.number(),
    text: z.string(),
  })
  .passthrough();

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/**
 * 통화 전사 상태. status 에 따라 채워지는 필드가 다름:
 * - "completed": callId, segmentCount, segments
 * - "pending":   startedAt
 * - "failed":    stage, error. stage="trigger" 는 시스템 실패로 재요청 가능
 * - "not_requested": 이외 필드 비어있음
 */
export const TranscriptStatusSchema = z
  .object({
    status: z.enum(['completed', 'pending', 'failed', 'not_requested']),
    callId: z.string().optional(),
    segmentCount: z.number().optional(),
    segments: z.array(TranscriptSegmentSchema).optional(),
    startedAt: z.string().optional(),
    stage: z.enum(['download', 'runtime', 'trigger']).nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();

export type TranscriptStatus = z.infer<typeof TranscriptStatusSchema>;

/** POST 요청이 accept 되어 Job 이 트리거된 상태 (202). */
export const TranscriptRequestAcceptedSchema = z
  .object({
    status: z.literal('pending'),
    callId: z.string(),
  })
  .passthrough();

export type TranscriptRequestAccepted = z.infer<typeof TranscriptRequestAcceptedSchema>;
