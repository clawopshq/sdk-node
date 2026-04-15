import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import { CallSchema, CallControlResponseSchema } from '../types/call.js';
import type { Call, CallControlResponse } from '../types/call.js';
import type { CallCreateParams, CallListParams } from '../types/call-params.js';

export class Calls extends APIResource {
  async create(
    params: CallCreateParams,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Call> {
    const body = stripNotGiven({
      To: params.to,
      From: params.from,
      Url: params.url,
      AI: params.ai
        ? stripNotGiven({
            Provider: params.ai.provider,
            Model: params.ai.model,
            ApiKey: params.ai.apiKey,
            Voice: params.ai.voice,
            Language: params.ai.language,
            Messages: params.ai.messages,
            Tools: params.ai.tools,
            Greeting: params.ai.greeting,
            TurnDetection: params.ai.turnDetection,
            RealtimeInputConfig: params.ai.realtimeInputConfig,
          })
        : undefined,
      StatusCallback: params.statusCallback,
      StatusCallbackEvent: params.statusCallbackEvent,
      Timeout: params.timeout,
    });
    return this._client._post(`${this._basePath}/calls`, {
      body,
      castTo: CallSchema,
      ...options,
    });
  }

  async list(
    params: CallListParams = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Page<Call>> {
    const query = stripNotGiven({
      status: params.status,
      from: params.from,
      to: params.to,
      number: params.number,
      page: params.page,
      pageSize: params.pageSize,
    });
    const path = `${this._basePath}/calls`;
    const schema = PageSchema(CallSchema);
    const raw = await this._client._get(path, {
      castTo: schema,
      query: Object.keys(query).length ? query : undefined,
      ...options,
    });
    const page = new Page<Call>(raw.data, raw.meta);
    page._setClient(this._client, path, CallSchema, query);
    return page;
  }

  async get(
    callId: string,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Call> {
    return this._client._get(`${this._basePath}/calls/${callId}`, {
      castTo: CallSchema,
      ...options,
    });
  }

  async update(
    callId: string,
    params: { status?: 'completed' } = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<CallControlResponse> {
    return this._client._post(`${this._basePath}/calls/${callId}`, {
      body: { Status: params.status ?? 'completed' },
      castTo: CallControlResponseSchema,
      ...options,
    });
  }
}
