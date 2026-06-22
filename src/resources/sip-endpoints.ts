import { z } from 'zod';
import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { SipEndpointSchema } from '../types/sip.js';
import type { SipEndpoint } from '../types/sip.js';

/**
 * SIP 엔드포인트(외부 PBX 트렁크) 리소스 — 조회 전용.
 * 생성/수정/삭제는 대시보드 또는 REST API 사용. 본 SDK 는 sip 라우팅 설정에
 * 필요한 endpoint id 확인용 list/get 만 제공한다.
 */
export class SipEndpoints extends APIResource {
  async list(
    params: { status?: 'active' | 'disabled'; page?: number; pageSize?: number } = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<SipEndpoint[]> {
    const query = stripNotGiven({
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    });
    const schema = z.object({ data: z.array(SipEndpointSchema) }).passthrough();
    const result = await this._client._get(`${this._basePath}/sip-endpoints`, {
      castTo: schema,
      ...options,
      extraQuery: { ...query, ...options.extraQuery },
    });
    return result.data;
  }

  async get(
    endpointId: string,
    options: { extraHeaders?: Record<string, string>; timeout?: number } = {},
  ): Promise<SipEndpoint> {
    return this._client._get(`${this._basePath}/sip-endpoints/${endpointId}`, {
      castTo: SipEndpointSchema,
      ...options,
    });
  }
}
