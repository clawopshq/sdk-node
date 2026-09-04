/** 문자 타입. 발송·대체발송·목록 필터가 같은 어휘를 쓴다. */
export type TextMessageType = 'sms' | 'lms' | 'mms';

/** 문자·알림톡 공통 필드. */
interface MessageCreateBaseParams {
  to: string;
  from: string;
  /**
   * 발송 멱등키. 같은 계정에서 같은 키로 다시 요청하면 발송하지 않고 1회차 결과를 돌려준다.
   * 재시도·재실행 경로가 있는 호출자만 채운다.
   *
   * ⚠️ 순차 재시도를 막는 용도다. 같은 키로 **동시에** 두 요청이 들어오면 둘 다 발송될 수 있다.
   */
  idempotencyKey?: string;
}

/** SMS/LMS/MMS 발송 파라미터. */
export interface TextMessageCreateParams extends MessageCreateBaseParams {
  body: string;
  /**
   * 생략하면 서버가 고른다 — `mediaUrl` 이 있으면 `mms`, `subject` 가 있거나 본문이
   * EUC-KR 90byte(한글 45자)를 넘으면 `lms`, 그 외에는 `sms`.
   *
   * `'sms'` 로 명시한 본문이 90byte 를 넘으면 `400 body_too_long` 이다. 길이가 런타임에
   * 정해지는 경우(템플릿 치환 등)에는 생략하는 편이 안전하다.
   */
  type?: TextMessageType;
  subject?: string;
  /** MMS 첨부 (최대 3개). jpg·jpeg·png·bmp, 장당 300KB 이하. */
  mediaUrl?: string[];
  kakao?: never;
  brand?: never;
  fallback?: never;
}

/** 알림톡 템플릿 지정. 구조(본문·버튼·아이템·강조)는 검수된 템플릿이 정하고, 요청은 값만 채운다. */
export interface KakaoSendParams {
  /** `kakao.channels.list()` 의 `data[].id` (ClawOps 리소스 ID). */
  channelId: string;
  /** `kakao.templates.list()` 의 `data[].id` (ClawOps 리소스 ID). */
  templateId: string;
  /**
   * 템플릿 변수. 키는 `고객명` 과 `#{고객명}` 을 모두 받는다.
   *
   * 템플릿이 요구하는 변수가 빠지면 `400 kakao_variable_missing`, 템플릿에 없는 변수를 주면
   * `400 kakao_variable_unknown` 이다. 버튼 링크·강조 문구에 들어간 변수도 같은 목록에 포함된다.
   *
   * 채워야 할 이름은 `kakao.templates.list()` 응답의 `variables` 가 알려준다.
   */
  variables?: Record<string, string>;
}

/** 알림톡이 발송 실패했을 때 대신 나갈 문자. */
export interface KakaoFallbackParams {
  /** 생략하면 알림톡 본문(변수 치환 결과)을 그대로 문자로 보낸다. */
  body?: string;
  subject?: string;
  /** 생략하면 본문 길이에 맞춰 서버가 고른다. */
  type?: TextMessageType;
  /** `true` 면 알림톡이 실패해도 문자를 보내지 않는다 — 실패가 그대로 실패로 남는다. */
  disabled?: boolean;
}

/**
 * 카카오 알림톡 발송 파라미터.
 *
 * **본문은 템플릿이 정한다.** `body`·`subject`·`mediaUrl` 은 실을 수 없고(서버가 400),
 * 버튼·아이템 리스트·강조 문구는 카카오 검수를 받은 그대로 발송된다 — 요청으로 바꿀 수 없다.
 *
 * 대체발송된 문자는 **별도의 메시지 1건**으로 기록되고 문자 단가로 청구된다.
 */
export interface KakaoMessageCreateParams extends MessageCreateBaseParams {
  kakao: KakaoSendParams;
  brand?: never;
  fallback?: KakaoFallbackParams;
  /** `kakao` 를 실으면 알림톡이다. 명시할 필요가 없고, 명시한다면 `'ata'` 뿐이다. */
  type?: 'ata';
  body?: never;
  subject?: never;
  mediaUrl?: never;
}

/** 브랜드 메시지 템플릿 지정. 구조(본문·버튼·이미지)는 등록한 템플릿이 정한다. */
export interface BrandSendParams {
  /** `kakao.channels.list()` 의 `data[].id` (ClawOps 리소스 ID). */
  channelId: string;
  /**
   * `kakao.brandTemplates.list()` 의 `data[].id` (ClawOps 리소스 ID).
   */
  templateId: string;
  /**
   * 템플릿 변수. 키는 `고객명` 과 `#{고객명}` 을 모두 받는다.
   *
   * 채워야 할 이름은 `kakao.brandTemplates.list()` 응답의 `variables` 가 알려준다.
   */
  variables?: Record<string, string>;
}

/**
 * 카카오 브랜드 메시지 발송 파라미터.
 *
 * 채널을 **추가한 친구**에게 나가는 광고성 메시지다. 알림톡과 갈리는 점 둘:
 *
 * - **야간에 못 보낸다.** 20:50~08:00(KST)은 `422 kakao_brand_night_blocked` 다.
 * - **대체발송이 없다.** `fallback` 을 실으면 `400 kakao_fallback_not_allowed` 라서
 *   타입에서도 막는다.
 *
 * `(광고)` 표기와 수신거부 안내는 카카오가 붙이므로 본문에 넣지 않는다.
 */
export interface BrandMessageCreateParams extends MessageCreateBaseParams {
  brand: BrandSendParams;
  /** `brand` 를 실으면 브랜드 메시지다. 명시할 필요가 없고, 명시한다면 `'bms'` 뿐이다. */
  type?: 'bms';
  body?: never;
  subject?: never;
  mediaUrl?: never;
  kakao?: never;
  fallback?: never;
}

/**
 * 발송 파라미터. 문자·알림톡·브랜드 메시지는 **서로 배타적**이다 — 서버 규칙이 그렇고,
 * 섞으면 컴파일 에러다.
 */
export type MessageCreateParams =
  | TextMessageCreateParams
  | KakaoMessageCreateParams
  | BrandMessageCreateParams;

export interface MessageListParams {
  type?: TextMessageType | 'ata' | 'bms';
  status?: 'queued' | 'sent' | 'failed' | 'received';
  /** 발신 또는 수신 번호. 하이픈 유무를 모두 매칭한다. */
  number?: string;
  page?: number;
  pageSize?: number;
}

// ─── 컴파일 타임 검증 ────────────────────────────────────────────────────────
// 문자·알림톡·브랜드가 섞이지 않는지 tsc 가 확인한다. 타입 전용이라 런타임 코드는 0바이트다.
// ⚠️ `tests/` 는 tsconfig 의 exclude 에 있어 타입 검사를 받지 않는다 — 테스트 파일에
//    `@ts-expect-error` 로 적으면 아무도 읽지 않는 주석이 된다. 그래서 여기에 둔다.
type Rejected<T> = T extends MessageCreateParams ? false : true;
type Assert<T extends true> = T;

type _BodyWithKakaoIsRejected = Assert<
  Rejected<{ to: string; from: string; body: string; kakao: KakaoSendParams }>
>;
type _MediaWithKakaoIsRejected = Assert<
  Rejected<{ to: string; from: string; kakao: KakaoSendParams; mediaUrl: string[] }>
>;
type _SubjectWithKakaoIsRejected = Assert<
  Rejected<{ to: string; from: string; kakao: KakaoSendParams; subject: string }>
>;
type _TextTypeWithKakaoIsRejected = Assert<
  Rejected<{ to: string; from: string; kakao: KakaoSendParams; type: 'sms' }>
>;
type _FallbackWithoutKakaoIsRejected = Assert<
  Rejected<{ to: string; from: string; body: string; fallback: KakaoFallbackParams }>
>;

type _BodyWithBrandIsRejected = Assert<
  Rejected<{ to: string; from: string; body: string; brand: BrandSendParams }>
>;
type _MediaWithBrandIsRejected = Assert<
  Rejected<{ to: string; from: string; brand: BrandSendParams; mediaUrl: string[] }>
>;
type _TextTypeWithBrandIsRejected = Assert<
  Rejected<{ to: string; from: string; brand: BrandSendParams; type: 'sms' }>
>;
type _FallbackWithBrandIsRejected = Assert<
  Rejected<{ to: string; from: string; brand: BrandSendParams; fallback: KakaoFallbackParams }>
>;
// ⛔ 둘을 같이 실으면 서버가 `kakao_type_conflict` 로 거절한다 — 어느 쪽으로 나갈지 정해 줄 수 없다.
type _KakaoWithBrandIsRejected = Assert<
  Rejected<{ to: string; from: string; kakao: KakaoSendParams; brand: BrandSendParams }>
>;
type _SubjectWithBrandIsRejected = Assert<
  Rejected<{ to: string; from: string; brand: BrandSendParams; subject: string }>
>;

// 목록 필터 어휘. 발송과 달리 유니온 갈래가 없어 스탬프가 못 막으므로 여기서 직접 못박는다.
type _BmsIsFilterable = Assert<'bms' extends NonNullable<MessageListParams['type']> ? true : false>;
