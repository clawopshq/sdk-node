export { ClawOps } from './client.js';
export type { ClawOpsOptions } from './client.js';
export { default } from './client-default.js';

export { APIClient } from './base-client.js';
export type { APIClientOptions } from './base-client.js';

export { VERSION } from './version.js';

export {
  ClawOpsError,
  APIError,
  APIStatusError,
  APIConnectionError,
  APITimeoutError,
  APIResponseValidationError,
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  InternalServerError,
  ServiceUnavailableError,
  AgentError,
  AgentConnectionError,
} from './error.js';

export { WebhookVerificationError, Webhooks } from './webhooks.js';

export { Page } from './pagination.js';

export { Calls } from './resources/calls.js';
export { Messages } from './resources/messages.js';
export { Numbers } from './resources/numbers.js';
export { WebhookLogs } from './resources/webhook-logs.js';
export { AccountContext } from './resources/accounts.js';

export type {
  PaginationMeta,
  Call,
  CallControlResponse,
  CallCreateParams,
  CallListParams,
  CallUpdateParams,
  Message,
  MessageCreateParams,
  MessageListParams,
  PhoneNumber,
  NumberListItem,
  NumberUpdateResponse,
  NumberCreateParams,
  NumberUpdateParams,
  WebhookLog,
} from './types/index.js';
