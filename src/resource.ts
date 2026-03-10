import type { APIClient } from './base-client.js';

export class APIResource {
  protected _client: APIClient;
  protected _accountId: string;

  constructor(client: APIClient, accountId: string) {
    this._client = client;
    this._accountId = accountId;
  }

  protected get _basePath(): string {
    return `/v1/accounts/${this._accountId}`;
  }
}
