import { z } from 'zod';

/**
 * 화자 식별자. **2026-08 이후 전사는 `speaker_0`·`speaker_1`… 형식**이고, 전환 통화처럼
 * 참여자가 셋 이상이면 그만큼 늘어난다. 그 이전 전사에는 `AGENT`·`CUSTOMER` 가 그대로
 * 남아 있으므로 **두 형식을 모두 받아야 한다.** 화자와 역할의 연결은 보장되지 않는다.
 */
export type TranscriptSpeaker = 'CUSTOMER' | 'AGENT' | (string & {});

export const TranscriptSegmentSchema = z
  .object({
    /**
     * ⛔ **닫힌 enum 으로 두지 않는다.** 서버는 이미 `speaker_0` 을 보내고 있고, 세그먼트
     * 하나가 어긋나면 `segments` 배열 때문에 **전사 응답 전체**가 실패한다.
     */
    speaker: z.string() as z.ZodType<TranscriptSpeaker>,
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
