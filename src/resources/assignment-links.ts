import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import {
  AssignmentLinkSchema,
  AssignmentLinkCreateResponseSchema,
} from '../types/assignment-link.js';
import type {
  AssignmentLink,
  AssignmentLinkCreateResponse,
  AssignmentLinkStatus,
} from '../types/assignment-link.js';

type RequestOptions = {
  extraHeaders?: Record<string, string>;
  extraQuery?: Record<string, unknown>;
  timeout?: number;
};

/**
 * 관리번호(External Assignment) 발급 링크 리소스.
 *
 * POST/DELETE는 `external_assignment` 애드온이 활성화된 계정에서만 가능합니다.
 * GET 조회는 애드온 활성 여부와 무관하게 가능합니다.
 */
export class AssignmentLinks extends APIResource {
  async create(
    params: {
      webhookUrl?: string;
      webhookMethod?: 'POST' | 'GET';
      note?: string;
    } = {},
    options: RequestOptions = {},
  ): Promise<AssignmentLinkCreateResponse> {
    const body = stripNotGiven({
      webhookUrl: params.webhookUrl,
      webhookMethod: params.webhookMethod,
      note: params.note,
    });
    return this._client._post(`${this._basePath}/assignment-links`, {
      body: Object.keys(body).length ? body : undefined,
      castTo: AssignmentLinkCreateResponseSchema,
      ...options,
    });
  }

  async list(
    params: {
      status?: AssignmentLinkStatus;
      page?: number;
      pageSize?: number;
    } = {},
    options: RequestOptions = {},
  ): Promise<Page<AssignmentLink>> {
    const query = stripNotGiven({
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    });
    const path = `${this._basePath}/assignment-links`;
    const schema = PageSchema(AssignmentLinkSchema);
    const raw = await this._client._get(path, {
      castTo: schema,
      query: Object.keys(query).length ? query : undefined,
      ...options,
    });
    const page = new Page<AssignmentLink>(raw.data, raw.meta);
    page._setClient(this._client, path, AssignmentLinkSchema, query);
    return page;
  }

  async retrieve(
    linkId: string,
    options: RequestOptions = {},
  ): Promise<AssignmentLink> {
    return this._client._get(`${this._basePath}/assignment-links/${linkId}`, {
      castTo: AssignmentLinkSchema,
      ...options,
    });
  }

  async revoke(
    linkId: string,
    options: { extraHeaders?: Record<string, string>; timeout?: number } = {},
  ): Promise<void> {
    await this._client._delete(
      `${this._basePath}/assignment-links/${linkId}`,
      options,
    );
  }
}
