import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import { MessageSchema } from '../types/message.js';
import type { Message } from '../types/message.js';
import type { MessageCreateParams, MessageListParams } from '../types/message-params.js';

export class Messages extends APIResource {
  async create(
    params: MessageCreateParams,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Message> {
    const body = stripNotGiven({
      To: params.to,
      From: params.from,
      Body: params.body,
      Type: params.type,
      Subject: params.subject,
      MediaUrl: params.mediaUrl,
      IdempotencyKey: params.idempotencyKey,
    });
    return this._client._post(`${this._basePath}/messages`, {
      body,
      castTo: MessageSchema,
      ...options,
    });
  }

  async list(
    params: MessageListParams = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Page<Message>> {
    const query = stripNotGiven({
      type: params.type,
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    });
    const path = `${this._basePath}/messages`;
    const schema = PageSchema(MessageSchema);
    const raw = await this._client._get(path, {
      castTo: schema,
      query: Object.keys(query).length ? query : undefined,
      ...options,
    });
    const page = new Page<Message>(raw.data, raw.meta);
    page._setClient(this._client, path, MessageSchema, query);
    return page;
  }

  async get(
    messageId: string,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Message> {
    return this._client._get(`${this._basePath}/messages/${messageId}`, {
      castTo: MessageSchema,
      ...options,
    });
  }
}
