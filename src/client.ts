import { APIClient, type APIClientOptions } from './base-client.js';
import { DEFAULT_BASE_URL } from './constants.js';
import { ClawOpsError } from './error.js';
import { Calls } from './resources/calls.js';
import { Messages } from './resources/messages.js';
import { Numbers } from './resources/numbers.js';
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

  get webhookLogs(): WebhookLogs {
    return new WebhookLogs(this, this._defaultAccountId);
  }

  get webhooks(): Webhooks {
    return new Webhooks();
  }

  accounts(accountId: string): AccountContext {
    return new AccountContext(this, accountId);
  }
}
