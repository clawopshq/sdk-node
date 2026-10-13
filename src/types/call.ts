import { z } from 'zod';

/**
 * 전환(담당자 연결) 시도 한 건. `GET /calls/{id}` 단건 조회의 `transfers[]` 에만 들어 있다
 * (목록 조회에는 없다). sequence 순으로 정렬돼 있다.
 *
 * 담당자가 받기까지 걸린 시간은 `answeredAt - startedAt` 이다. `connectedAt` 은 warm 전환에서
 * 연결 전 안내가 끝난 뒤 시각이라 그만큼 늦다.
 *
 * 필드는 전부 optional 이다. `Call.transfers` 는 이 스키마로 항목을 검증하지 않는다(받은 값 그대로,
 * `CallSchema` 의 transfers 주석). 이 스키마는 타입의 정본이자 SDK 내부 테스트용이다.
 */
export const TransferLegSchema = z
  .object({
    /** 이 통화에서 몇 번째 시도인지(1부터). 전환 웹훅의 `TransferSequence` 와 같은 값. */
    sequence: z.number().nullable().optional(),
    to: z.string().nullable().optional(),
    /** blind / warm / refer / refer-attended. */
    mode: z.string().nullable().optional(),
    /** pstn / sip. 2026-07-10 이전 전환은 null. */
    destinationType: z.string().nullable().optional(),
    /**
     * initiated / ringing / connected / completed / failed / no-answer / busy / canceled / interrupted.
     * enum 으로 좁히지 않는다 — 서버가 값을 넓힐 때 SDK 릴리스를 기다리지 않게(hangupCause 와 같은 이유).
     */
    status: z.string().nullable().optional(),
    /** 연결→종료 초(관측값). 과금 초는 billableDuration. 연결되지 못했으면 null. */
    duration: z.number().nullable().optional(),
    /** 과금 대상 여부. 한 통화에서 최대 한 건만 true. */
    billable: z.boolean().optional(),
    billableDuration: z.number().nullable().optional(),
    hangupCauseQ850: z.number().nullable().optional(),
    sipResponseCode: z.number().nullable().optional(),
    /** 통신망 원본 진단 텍스트(자유 형식 — 분기 조건으로 쓰지 말 것). */
    reasonText: z.string().nullable().optional(),
    /** 시도를 시작한 시각(ISO 8601). 2026-07-10 이전 전환은 null. */
    startedAt: z.string().nullable().optional(),
    /**
     * 대상이 전화를 받은 시각. 연결 전 안내 도중 끝나도 남는다.
     *
     * 받았는지 판정: **값이 있으면 받은 것이다** — 안내 도중 끝난 warm 전환은 status 가 `failed` 지만
     * 받은 전환이다. 2026-10-13 이전 전환은 받았어도 null 이라, 그 구간만 status 로 판정한다.
     */
    answeredAt: z.string().nullable().optional(),
    /** 발신자와 대상이 연결된 시각(안내가 있으면 안내가 끝난 뒤). 연결되지 못했으면 null. */
    connectedAt: z.string().nullable().optional(),
    endedAt: z.string().nullable().optional(),
    /**
     * 이 시도에 적용한 대기 한도(초). 2026-10-13 이전 전환은 null. `refer-attended` 는 이미 연결된
     * 상담 통화로 넘겨 기다리는 단계가 없으므로 항상 null 이다.
     */
    timeout: z.number().nullable().optional(),
  })
  .passthrough();

export type TransferLeg = z.infer<typeof TransferLegSchema>;

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
     * 수신 통화에서 발신자가 번호 표시제한(`*23#` 등)을 걸고 건 통화면 true, 아니면 false.
     * 번호는 `from` 에 그대로 있다. 발신 통화와 2026-09-29 이전의 수신 통화는 null.
     */
    callerIdRestricted: z.boolean().nullable().optional(),
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
    /**
     * 전환(담당자 연결) 요약 — 이 통화의 **대표 시도** 하나에서 나온 값이다. 대표는 **끝난 시도**
     * (completed / failed / busy / no-answer / canceled) 중 completed 우선, 같으면 마지막 시도다.
     *
     * ⚠️ null 이 「전환이 없었다」를 뜻하지 않는다 — 시도가 아직 진행 중이거나 `interrupted` 로만 끝났어도
     *    null 이다. 전환 여부는 `transfers` 로 판정할 것.
     */
    transferTo: z.string().nullable().optional(),
    transferStatus: z.string().nullable().optional(),
    /** 연결→종료 초(관측값, 과금 초 아님). 연결되지 못했으면 null. */
    transferDuration: z.number().nullable().optional(),
    transferHangupCauseQ850: z.number().nullable().optional(),
    transferSipResponseCode: z.number().nullable().optional(),
    /**
     * 통신망 원본 진단 텍스트. ⚠️ 위 대표 시도가 아니라 **마지막으로 기록된** 통신망 사유라, 여러 번
     * 시도한 통화에서는 다른 시도의 것일 수 있다(대표 시도는 completed 인데 이 값은 실패 사유인 경우).
     * 시도별 사유는 `transfers[].reasonText` 를 쓴다.
     */
    transferReasonText: z.string().nullable().optional(),
    /**
     * 전환 시도 전체(sequence 순). **단건 조회(`calls.get`)에만** 있고 그 밖의 응답(목록·생성·수정)에는 없다.
     *
     * 타입은 `TransferLeg` 지만 런타임에서는 항목이 객체인지만 본다 — 이 타입이 생기기 전에는 passthrough 로
     * 받았으므로, 시도 하나의 값 타입이 어긋났다고 `calls.get` 전체가 검증 오류로 실패하면 회귀다.
     */
    transfers: z
      .array(z.custom<TransferLeg>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)))
      .optional(),
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
