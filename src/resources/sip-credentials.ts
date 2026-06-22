import { z } from 'zod';
import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { SipCredentialSchema } from '../types/sip.js';
import type { SipCredential } from '../types/sip.js';

/**
 * SIP 단말(credential) 리소스 — 조회 전용.
 * 생성/수정/삭제는 대시보드 또는 REST API 사용. 본 SDK 는 softphone 라우팅 설정에
 * 필요한 credential id 확인용 list/get 만 제공한다 (password/ha1 미노출).
 */
export class SipCredentials extends APIResource {
  async list(
    params: { status?: 'active' | 'disabled'; page?: number; pageSize?: number } = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<SipCredential[]> {
    const query = stripNotGiven({
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    });
    const schema = z.object({ data: z.array(SipCredentialSchema) }).passthrough();
    const result = await this._client._get(`${this._basePath}/sip-credentials`, {
      castTo: schema,
      ...options,
      extraQuery: { ...query, ...options.extraQuery },
    });
    return result.data;
  }

  async get(
    credentialId: string,
    options: { extraHeaders?: Record<string, string>; timeout?: number } = {},
  ): Promise<SipCredential> {
    return this._client._get(`${this._basePath}/sip-credentials/${credentialId}`, {
      castTo: SipCredentialSchema,
      ...options,
    });
  }
}
