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
  }
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
