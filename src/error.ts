/**
 * 서버가 에러 응답의 `code` 로 싣는 값.
 *
 * 문구가 아니라 **이 값으로 분기한다** — 한글 메시지는 바뀔 수 있다.
 *
 * ⚠️ 문자 도메인은 snake_case, 카카오 채널 도메인은 SCREAMING_CASE 다. 서버가 실제로
 * 그렇게 보내므로 SDK 가 임의로 정규화하지 않는다. 열린 유니온이라 목록에 없는 코드도
 * 그대로 실린다(자동완성만 돕는다).
 */
export type ClawOpsErrorCode =
  // 발송 일반
  | 'invalid_phone'
  | 'invalid_type'
  | 'invalid_input'
  | 'from_not_registered'
  | 'body_too_long'
  | 'sms_no_subject'
  | 'sms_no_media'
  | 'lms_no_media'
  | 'too_many_media'
  | 'invalid_media_ext'
  | 'media_download_failed'
  | 'type_not_supported'
  | 'messaging_blocked'
  | 'recipient_blocked'
  | 'quota_exceeded'
  | 'override_quota_exceeded'
  | 'no_active_subscription'
  // 알림톡 발송
  | 'kakao_required'
  | 'kakao_type_conflict'
  | 'kakao_body_not_allowed'
  | 'kakao_subject_not_allowed'
  | 'kakao_media_not_allowed'
  | 'kakao_channel_not_found'
  | 'kakao_template_not_found'
  | 'kakao_template_not_approved'
  | 'kakao_template_dormant'
  | 'kakao_variable_missing'
  | 'kakao_variable_unknown'
  | 'kakao_send_failed'
  | 'kakao_unavailable'
  | 'invalid_fallback_type'
  // 카카오 채널 연동
  | 'KAKAO_TOKEN_INVALID'
  | 'KAKAO_CHANNEL_ALREADY_LINKED'
  | 'KAKAO_CHANNEL_REJECTED'
  | 'KAKAO_RATE_LIMITED'
  | 'KAKAO_PROVIDER_UNAVAILABLE'
  // 공통
  | 'VALIDATION'
  | 'NOT_FOUND'
  | (string & {});

export class ClawOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClawOpsError';
  }
}

export class APIError extends ClawOpsError {
  readonly request: { method: string; url: string };

  constructor(message: string, request: { method: string; url: string }) {
    super(message);
    this.name = 'APIError';
    this.request = request;
  }
}

export class APIStatusError extends APIError {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers | undefined;
  /**
   * 서버가 함께 보낸 기계 판독용 코드(`{ error, code }`). 없으면 undefined 다.
   *
   * 같은 상태 코드가 서로 다른 사유를 담는다 — 422 만 해도 수신거부(`recipient_blocked`)와
   * 할당량 초과(`quota_exceeded`)가 갈리고, 한글 문구로 구분하면 문구가 바뀔 때 깨진다.
   */
  readonly code: ClawOpsErrorCode | undefined;

  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, request);
    this.name = 'APIStatusError';
    this.status = response.status;
    this.body = body;
    this.headers = response.headers;
    this.code = extractErrorCode(body);
  }
}

/** 응답 본문에서 `code` 를 꺼낸다. 문자열이 아니면 없는 것으로 본다. */
function extractErrorCode(body: unknown): ClawOpsErrorCode | undefined {
  const code = (body as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

export class BadRequestError extends APIStatusError {
  override readonly status = 400 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'BadRequestError';
  }
}

export class AuthenticationError extends APIStatusError {
  override readonly status = 401 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'AuthenticationError';
  }
}

export class PermissionDeniedError extends APIStatusError {
  override readonly status = 403 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'PermissionDeniedError';
  }
}

export class NotFoundError extends APIStatusError {
  override readonly status = 404 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends APIStatusError {
  override readonly status = 409 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'ConflictError';
  }
}

export class UnprocessableEntityError extends APIStatusError {
  override readonly status = 422 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'UnprocessableEntityError';
  }
}

/**
 * HTTP 429 Too Many Requests.
 *
 * 동시 통화 한도 초과 등 일시적 제한. SDK는 자동 재시도(최대 2회, 지수 backoff)를 수행한다.
 * 즉각 피드백이 필요하면 client 생성 시 maxRetries: 0으로 재시도를 비활성화하라.
 */
export class RateLimitError extends APIStatusError {
  override readonly status = 429 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'RateLimitError';
  }
}

export class InternalServerError extends APIStatusError {
  override readonly status = 500 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'InternalServerError';
  }
}

export class ServiceUnavailableError extends APIStatusError {
  override readonly status = 503 as const;
  constructor(
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) {
    super(message, response, body, request);
    this.name = 'ServiceUnavailableError';
  }
}

export class APIConnectionError extends APIError {
  constructor(request: { method: string; url: string }, message = 'Connection error.') {
    super(message, request);
    this.name = 'APIConnectionError';
  }
}

export class APITimeoutError extends APIConnectionError {
  constructor(request: { method: string; url: string }) {
    super(request, 'Request timed out.');
    this.name = 'APITimeoutError';
  }
}

export class APIResponseValidationError extends APIError {
  readonly status: number;

  constructor(response: { status: number }, request: { method: string; url: string }) {
    super('API response validation failed.', request);
    this.name = 'APIResponseValidationError';
    this.status = response.status;
  }
}

/**
 * 솔라피 호환 레이어가 호출을 거절할 때 쓴다.
 * 조용히 다르게 동작하느니 여기서 멈추는 편이 낫다고 판단한 경우들이다.
 */
export class SolapiBridgeError extends ClawOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'SolapiBridgeError';
  }
}

export class AgentError extends ClawOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export class AgentConnectionError extends AgentError {
  constructor(message = 'Agent WebSocket connection failed.') {
    super(message);
    this.name = 'AgentConnectionError';
  }
}

const STATUS_CODE_TO_ERROR: Record<
  number,
  new (
    message: string,
    response: { status: number; headers?: Headers },
    body: unknown,
    request: { method: string; url: string },
  ) => APIStatusError
> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: UnprocessableEntityError,
  429: RateLimitError,
  500: InternalServerError,
  503: ServiceUnavailableError,
};

export function makeStatusError(
  status: number,
  body: unknown,
  headers: Headers | undefined,
  request: { method: string; url: string },
): APIStatusError {
  let message = '';
  if (body && typeof body === 'object' && 'error' in body) {
    message = (body as { error: string }).error;
  } else {
    message = `HTTP ${status}`;
  }

  const ErrorClass = STATUS_CODE_TO_ERROR[status];
  if (ErrorClass) {
    return new ErrorClass(message, { status, headers }, body, request);
  }
  if (status >= 500) {
    return new InternalServerError(message, { status, headers }, body, request);
  }
  return new APIStatusError(message, { status, headers }, body, request);
}
