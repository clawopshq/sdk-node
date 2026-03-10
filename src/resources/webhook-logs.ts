import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import { WebhookLogSchema } from '../types/webhook-log.js';
import type { WebhookLog } from '../types/webhook-log.js';

export class WebhookLogs extends APIResource {
  async list(
    webhookId: string,
    params: { page?: number; pageSize?: number } = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Page<WebhookLog>> {
    const query = stripNotGiven({ page: params.page, pageSize: params.pageSize });
    const path = `${this._basePath}/webhooks/${webhookId}/logs`;
    const schema = PageSchema(WebhookLogSchema);
    const raw = await this._client._get(path, {
      castTo: schema,
      query: Object.keys(query).length ? query : undefined,
      ...options,
    });
    const page = new Page<WebhookLog>(raw.data, raw.meta);
    page._setClient(this._client, path, WebhookLogSchema, query);
    return page;
  }
}
