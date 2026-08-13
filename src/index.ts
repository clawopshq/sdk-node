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
  RateLimitError,
  InternalServerError,
  ServiceUnavailableError,
  AgentError,
  AgentConnectionError,
} from './error.js';

export { WebhookVerificationError, Webhooks } from './webhooks.js';

export { Page } from './pagination.js';

export { AssignmentLinks } from './resources/assignment-links.js';
export { BlockedRecipients } from './resources/blocked-recipients.js';
export { Calls } from './resources/calls.js';
export { Messages } from './resources/messages.js';
export { Numbers } from './resources/numbers.js';
export { Recordings } from './resources/recordings.js';
export type { RecordingDownload } from './resources/recordings.js';
export { SipCredentials } from './resources/sip-credentials.js';
export { SipEndpoints } from './resources/sip-endpoints.js';
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
  RoutingType,
  SipCredential,
  SipEndpoint,
  WebhookLog,
  AssignmentLink,
  AssignmentLinkAssignment,
  AssignmentLinkCreateResponse,
  AssignmentLinkStatus,
  BlockedRecipient,
  BlockedChannel,
  BlockedRecipientStatus,
  BlockedRecipientSource,
} from './types/index.js';
