import type { APIClient } from '../base-client.js';
import { AssignmentLinks } from './assignment-links.js';
import { Calls } from './calls.js';
import { Messages } from './messages.js';
import { Numbers } from './numbers.js';
import { Recordings } from './recordings.js';
import { WebhookLogs } from './webhook-logs.js';

export class AccountContext {
  private _client: APIClient;
  private _accountId: string;

  constructor(client: APIClient, accountId: string) {
    this._client = client;
    this._accountId = accountId;
  }

  get calls(): Calls {
    return new Calls(this._client, this._accountId);
  }

  get messages(): Messages {
    return new Messages(this._client, this._accountId);
  }

  get numbers(): Numbers {
    return new Numbers(this._client, this._accountId);
  }

  get recordings(): Recordings {
    return new Recordings(this._client, this._accountId);
  }

  get webhookLogs(): WebhookLogs {
    return new WebhookLogs(this._client, this._accountId);
  }

  get assignmentLinks(): AssignmentLinks {
    return new AssignmentLinks(this._client, this._accountId);
  }
}
