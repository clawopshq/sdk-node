import { z } from 'zod';

/**
 * 채널 연결 상태. 서버가 어휘를 소유하므로 **열린 유니온**이다 — 목록에 없는 값도 그대로
 * 실리고, 낡는 것은 자동완성뿐이다.
 */
export type KakaoChannelStatus = 'connected' | 'needs_attention' | (string & {});

/**
 * 이 계정에 연결된 카카오 비즈니스 채널.
 *
 * ⚠️ `searchId` 는 채널 소유자가 카카오 비즈니스에서 바꿀 수 있다. **연동 키로 쓰지 말 것** —
 * 키는 `id`(ClawOps 리소스 ID)다.
 */
export const KakaoChannelSchema = z
  .object({
    /** ClawOps 채널 리소스 ID. 템플릿 조회와 알림톡 발송에 이 값을 쓴다. */
    id: z.string(),
    /** 카카오 채널 검색용 ID. `@` 없는 형태로 저장된다. */
    searchId: z.string(),
    name: z.string(),
    categoryCode: z.string(),
    /**
     * `connected` = 연결 완료. `needs_attention` = 연결 기록은 있으나 카카오 채널 상태를
     * 확인하지 못한 상태다 — 실제로 끊겼을 수도, 일시적인 조회 실패일 수도 있다.
     * `channels.retrieve()` 를 다시 부르면 재확인한다.
     *
     * ⛔ **닫힌 enum 으로 두지 않는다.** 어휘는 서버가 소유하므로, 상태가 하나 늘면
     * 닫힌 enum 은 조회를 통째로 실패시킨다(알림톡 `'ata'` 가 정확히 그렇게 터졌다).
     * 열린 유니온이면 자동완성만 낡고 조회는 계속 산다.
     */
    status: z.string() as z.ZodType<KakaoChannelStatus>,
    /** 담당자 휴대전화번호(마스킹). 원문은 저장하지 않는다. */
    managerPhoneMasked: z.string().nullable().optional(),
    connectedAt: z.string(),
    /** 카카오 채널 상태를 마지막으로 확인한 시각. null 이면 연결 이후 한 번도 확인하지 않았다. */
    syncedAt: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export type KakaoChannel = z.infer<typeof KakaoChannelSchema>;

/**
 * 알림톡 템플릿.
 *
 * 본문·버튼·아이템 리스트·강조 문구는 **카카오 검수를 받은 그대로** 발송된다. 발송 요청으로
 * 바꿀 수 있는 것은 `variables` 값뿐이다.
 */
export const KakaoTemplateSchema = z
  .object({
    /** ClawOps 템플릿 리소스 ID. 발송의 `kakao.templateId` 에 이 값을 쓴다. */
    id: z.string(),
    /** ClawOps 채널 리소스 ID. 발송의 `kakao.channelId` 와 같은 값이다. */
    channelId: z.string(),
    name: z.string(),
    /** 검수를 받은 템플릿 본문. `#{변수}` 자리는 발송 시 치환된다. */
    content: z.string(),
    /**
     * 카카오 검수 상태(`APPROVED`·`REJECTED` 등). **카카오 쪽 열린 집합이라 문자열이다.**
     * 발송 가능 여부 판정은 `sendable` 이 정본이다.
     */
    status: z.string(),
    /** 휴면 템플릿. `true` 면 승인 상태여도 발송할 수 없다. */
    dormant: z.boolean(),
    /** 지금 발송에 쓸 수 있으면 true. `status === 'APPROVED' && !dormant` 다. */
    sendable: z.boolean(),
    /** `CHANNEL`(채널 소유) 또는 `GROUP`(기본 제공). */
    assignType: z.string(),
    messageType: z.string(),
    emphasizeType: z.string(),
    /**
     * 발송 시 `kakao.variables` 에 모두 채워야 하는 변수 이름.
     * 버튼 링크·강조 문구에 들어간 변수도 이 한 목록에 모인다.
     */
    variables: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export type KakaoTemplate = z.infer<typeof KakaoTemplateSchema>;

/** 채널 업종 카테고리. **열린 집합이므로 코드에 하드코딩하지 말 것** — 이 응답이 정본이다. */
export const KakaoChannelCategorySchema = z
  .object({
    /** 채널 연결의 `categoryCode` 에 그대로 보내는 값. */
    code: z.string(),
    name: z.string(),
  })
  .passthrough();

export type KakaoChannelCategory = z.infer<typeof KakaoChannelCategorySchema>;

export const KakaoChannelCategoryListSchema = z
  .object({
    data: z.array(KakaoChannelCategorySchema),
    meta: z
      .object({
        /** 이 목록을 공급자에서 실제로 받아 온 시각. */
        fetchedAt: z.string(),
        /** 서버 캐시에서 응답했는지. 캐시는 짧고 값이 바뀌면 자동으로 따라간다. */
        cached: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export type KakaoChannelCategoryList = z.infer<typeof KakaoChannelCategoryListSchema>;

/**
 * 인증번호 발송 요청 접수 결과.
 *
 * **응답에 인증번호는 없다.** 인증번호는 카카오 비즈니스에 등록된 담당자 휴대전화로만 가고,
 * ClawOps 는 그 값을 받지도 저장하지도 않는다.
 */
export const KakaoTokenRequestSchema = z
  .object({
    requested: z.boolean(),
    /** 정규화된 검색용 ID. `channels.connect()` 에 이 값을 그대로 보낸다. */
    searchId: z.string(),
    /** 인증번호가 발송된 번호(마스킹). */
    phoneNumberMasked: z.string(),
    /** 재요청까지 기다릴 시간(초). */
    retryAfterSeconds: z.number(),
  })
  .passthrough();

export type KakaoTokenRequest = z.infer<typeof KakaoTokenRequestSchema>;
