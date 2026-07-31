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
    /**
     * 통화 종료 사유. status 가 왜 그렇게 끝났는지를 구분한다 — 특히 failed 는 결번·망 오류·
     * 시스템 오류를 모두 포함하는 대분류라, 발신 리스트를 정제하려면 status 가 아니라 이 값을 본다.
     *
     * 재시도해도 소용없음: invalid_number(결번) / number_changed / incompatible_destination.
     * 재시도 가치 있음: no_answer / user_busy / temporary_failure / switching_congestion /
     * no_circuit_available / network_out_of_order / destination_out_of_order /
     * recovery_on_timer_expire / resource_unavailable.
     * 그 외: normal_clearing(정상 종료) / caller_canceled / call_rejected / protocol_error /
     * unspecified / app_error·call_stuck(ClawOps 측 오류 — 재시도 권장) / unknown.
     *
     * enum 으로 좁히지 않는다 — 통신망이 새 cause 를 보내면 서버가 값을 넓히는데, 그때마다
     * SDK 릴리즈를 기다려야 파싱되는 구조는 안 된다.
     */
    hangupCause: z.string().nullable().optional(),
    /** 통신망 Q.850 cause code. 1·5·28=결번, 16=정상해제, 17=통화중, 19=무응답, 38=망장애. */
    hangupCauseQ850: z.number().nullable().optional(),
    /**
     * 종료를 유발한 SIP 응답코드(404=없는 번호, 486=통화중, 500=망 오류 등).
     * 국내 통신망은 실제 사유를 500 으로 감싸 보내기도 하므로 hangupCause 가 더 정확하다.
     */
    sipResponseCode: z.number().nullable().optional(),
    /**
     * 종료 책임 주체. carrier(통신망) / callee(수신자) / caller(발신자) /
     * app·system(ClawOps 측 오류 — 수신자 번호를 정제 대상에 넣지 말고 재시도할 것).
     */
    hangupSource: z.enum(['carrier', 'callee', 'caller', 'app', 'system']).nullable().optional(),
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
