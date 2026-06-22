import { z } from 'zod';
import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { PhoneNumberSchema } from '../types/number.js';
import type { PhoneNumber, NumberListItem, NumberUpdateResponse } from '../types/number.js';
import type { NumberUpdateParams } from '../types/number-params.js';

export class Numbers extends APIResource {
  async create(
    params: { webhookUrl?: string } = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<PhoneNumber> {
    const body = stripNotGiven({ webhookUrl: params.webhookUrl });
    return this._client._post(`${this._basePath}/numbers`, {
      body: Object.keys(body).length ? body : undefined,
      castTo: PhoneNumberSchema,
      ...options,
    });
  }

  async list(
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<NumberListItem[]> {
    const schema = z.object({ data: z.array(PhoneNumberSchema) }).passthrough();
    const result = await this._client._get(`${this._basePath}/numbers`, {
      castTo: schema,
      ...options,
    });
    return result.data;
  }

  async update(
    number: string,
    params: NumberUpdateParams = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<NumberUpdateResponse> {
    const body = stripNotGiven({
      webhookUrl: params.webhookUrl,
      webhookMethod: params.webhookMethod,
      routingType: params.routingType,
      sipEndpointId: params.sipEndpointId,
      sipCredentialId: params.sipCredentialId,
    });
    return this._client._put(`${this._basePath}/numbers/${number}`, {
      body,
      castTo: PhoneNumberSchema,
      ...options,
    });
  }

  async delete(
    number: string,
    options: {
      extraHeaders?: Record<string, string>;
      timeout?: number;
    } = {},
  ): Promise<void> {
    await this._client._delete(`${this._basePath}/numbers/${number}`, options);
  }
}
