import { z } from 'zod';

export const CallSchema = z
  .object({
    callId: z.string(),
    /**
     * 진행 중: queued / ringing / in-progress.
     * 종료: completed(응답 후 정상 종료) / no-answer(벨은 울렸으나 무응답) / busy(통화중) /
     * rejected(수신 거절) / canceled(응답 전 발신 측 취소) / failed(시스템·망 오류).
     * completed 만이 실제로 연결된 통화를 의미한다.
     */
    status: z.enum([
      'queued',
      'ringing',
      'in-progress',
      'completed',
      'failed',
      'busy',
      'no-answer',
      'canceled',
      'rejected',
    ]),
    to: z.string(),
    from: z.string(),
    direction: z.enum(['outbound', 'inbound']),
    duration: z.number().nullable().optional(),
    recordingUrl: z.string().nullable().optional(),
    /** AMD(machineDetection) 결과 — AMD 켠 발신 통화에만 값 존재. */
    answeredBy: z.enum(['human', 'machine', 'unknown']).nullable().optional(),
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
