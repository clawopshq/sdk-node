import { APIClient, type APIClientOptions } from './base-client.js';
import { DEFAULT_BASE_URL } from './constants.js';
import { ClawOpsError } from './error.js';
import { AssignmentLinks } from './resources/assignment-links.js';
import { BlockedRecipients } from './resources/blocked-recipients.js';
import { Calls } from './resources/calls.js';
import { Kakao } from './resources/kakao.js';
import { Messages } from './resources/messages.js';
import { Numbers } from './resources/numbers.js';
import { Recordings } from './resources/recordings.js';
import { SipCredentials } from './resources/sip-credentials.js';
import { SipEndpoints } from './resources/sip-endpoints.js';
import { WebhookLogs } from './resources/webhook-logs.js';
import { AccountContext } from './resources/accounts.js';
import { Webhooks } from './webhooks.js';

export interface ClawOpsOptions {
  apiKey?: string;
  accountId?: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: Record<string, string>;
}

export class ClawOps extends APIClient {
  private _defaultAccountId: string;

  constructor(options: ClawOpsOptions = {}) {
    let apiKey = options.apiKey ?? process.env.CLAWOPS_API_KEY;
    if (!apiKey) {
      throw new ClawOpsError('apiKey를 지정하거나 CLAWOPS_API_KEY 환경변수를 설정하세요.');
    }

    let accountId = options.accountId ?? process.env.CLAWOPS_ACCOUNT_ID;
    if (!accountId) {
      throw new ClawOpsError('accountId를 지정하거나 CLAWOPS_ACCOUNT_ID 환경변수를 설정하세요.');
    }

    const baseURL = options.baseURL ?? process.env.CLAWOPS_BASE_URL ?? DEFAULT_BASE_URL;

    super({
      apiKey,
      baseURL,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
      fetch: options.fetch,
      defaultHeaders: options.defaultHeaders,
    });

    this._defaultAccountId = accountId;
  }

  get calls(): Calls {
    return new Calls(this, this._defaultAccountId);
  }

  get messages(): Messages {
    return new Messages(this, this._defaultAccountId);
  }

  get numbers(): Numbers {
    return new Numbers(this, this._defaultAccountId);
  }

  get sipCredentials(): SipCredentials {
    return new SipCredentials(this, this._defaultAccountId);
  }

  get sipEndpoints(): SipEndpoints {
    return new SipEndpoints(this, this._defaultAccountId);
  }

  get recordings(): Recordings {
    return new Recordings(this, this._defaultAccountId);
  }

  get webhookLogs(): WebhookLogs {
    return new WebhookLogs(this, this._defaultAccountId);
  }

  get assignmentLinks(): AssignmentLinks {
    return new AssignmentLinks(this, this._defaultAccountId);
  }

  get blockedRecipients(): BlockedRecipients {
    return new BlockedRecipients(this, this._defaultAccountId);
  }

  /** 카카오 채널·알림톡 템플릿. 발송은 `messages.create({ kakao: … })` 다. */
  get kakao(): Kakao {
    return new Kakao(this, this._defaultAccountId);
  }

  get webhooks(): Webhooks {
    return new Webhooks();
  }

  accounts(accountId: string): AccountContext {
    return new AccountContext(this, accountId);
  }
}
