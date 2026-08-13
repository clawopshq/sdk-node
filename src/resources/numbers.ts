import { z } from 'zod';
import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { PhoneNumberSchema } from '../types/number.js';
import type { PhoneNumber, NumberListItem, NumberUpdateResponse } from '../types/number.js';
import type { NumberCreateParams, NumberUpdateParams } from '../types/number-params.js';

interface RequestOptions {
  extraHeaders?: Record<string, string>;
  extraQuery?: Record<string, unknown>;
  timeout?: number;
}

export class Numbers extends APIResource {
  /**
   * 번호를 발급합니다. 번호 풀에서 자동으로 배정되며 어떤 번호가 나올지는 지정할 수 없습니다.
   *
   * 발급 직후 번호는 `routingType: "webhook"` 이고 `webhookUrl` 이 비어 있어, 그대로 두면
   * 걸려온 전화가 거절됩니다. 이어서 `update()` 로 착신 라우팅을 지정하세요.
   */
  async create(params: NumberCreateParams = {}, options: RequestOptions = {}): Promise<PhoneNumber> {
    const body = stripNotGiven({
      webhookUrl: params.webhookUrl,
      webhookMethod: params.webhookMethod,
      webhookHeaders: params.webhookHeaders,
      statusCallback: params.statusCallback,
      statusCallbackEvents: params.statusCallbackEvents,
    });
    return this._client._post(`${this._basePath}/numbers`, {
      body: Object.keys(body).length ? body : undefined,
      castTo: PhoneNumberSchema,
      ...options,
    });
  }

  /**
   * 등록된 번호 목록을 조회합니다. 페이지네이션과 필터가 없으며 보유한 번호가 한 번에 전부
   * 반환됩니다.
   */
  async list(options: RequestOptions = {}): Promise<NumberListItem[]> {
    const schema = z.object({ data: z.array(PhoneNumberSchema) }).passthrough();
    const result = await this._client._get(`${this._basePath}/numbers`, {
      castTo: schema,
      ...options,
    });
    return result.data;
  }

  /**
   * 번호 설정을 수정합니다. 착신 라우팅(webhook/agent/callflow/forward/sip/softphone)과
   * webhook, 상태 통지, 받아쓰기 사전을 변경할 수 있습니다. 보낸 필드만 반영되고 생략한
   * 필드는 유지됩니다.
   *
   * 라우팅을 바꾸면 다른 라우팅 필드는 서버에서 자동으로 비워집니다. `agent` 에서
   * `webhook` 으로 되돌리면 `agentId` 가 null 이 되므로, 다시 `agent` 로 돌아갈 때
   * `agentId` 를 새로 지정해야 합니다.
   */
  async update(
    number: string,
    params: NumberUpdateParams = {},
    options: RequestOptions = {},
  ): Promise<NumberUpdateResponse> {
    const body = stripNotGiven({
      routingType: params.routingType,
      agentId: params.agentId,
      callFlowId: params.callFlowId,
      forwardTo: params.forwardTo,
      sipEndpointId: params.sipEndpointId,
      sipCredentialId: params.sipCredentialId,
      webhookUrl: params.webhookUrl,
      webhookMethod: params.webhookMethod,
      webhookHeaders: params.webhookHeaders,
      callContextUrl: params.callContextUrl,
      statusCallback: params.statusCallback,
      statusCallbackEvents: params.statusCallbackEvents,
      dictionaryId: params.dictionaryId,
    });
    return this._client._put(`${this._basePath}/numbers/${number}`, {
      body,
      castTo: PhoneNumberSchema,
      ...options,
    });
  }

  /**
   * 번호를 반납합니다. 번호는 풀로 복귀하며 되돌릴 수 없습니다. 같은 번호를 다시
   * 발급받는다는 보장이 없습니다.
   */
  async delete(
    number: string,
    options: { extraHeaders?: Record<string, string>; timeout?: number } = {},
  ): Promise<void> {
    await this._client._delete(`${this._basePath}/numbers/${number}`, options);
  }
}
