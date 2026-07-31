import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import { BlockedRecipientSchema } from '../types/blocked-recipient.js';
import type {
  BlockedRecipient,
  BlockedChannel,
  BlockedRecipientStatus,
  BlockedRecipientSource,
} from '../types/blocked-recipient.js';

type RequestOptions = {
  extraHeaders?: Record<string, string>;
  extraQuery?: Record<string, unknown>;
  timeout?: number;
};

/**
 * 수신거부(DNC) 명단 리소스.
 *
 * 등록된 번호는 이 계정의 **발신**(전화·문자)에서 제외됩니다. 착신은 막지 않습니다 —
 * 그 번호에서 걸려오는 전화는 그대로 받습니다.
 *
 * 전화와 문자는 각각 따로 차단합니다. 같은 번호라도 채널마다 별개 항목이므로,
 * 둘 다 막으려면 `channel` 을 바꿔 두 번 등록합니다.
 */
export class BlockedRecipients extends APIResource {
  /**
   * 번호를 수신거부 명단에 등록합니다.
   *
   * 하이픈·`+82` 표기 모두 허용되며 국내 표기로 정규화되어 저장됩니다.
   *
   * **멱등입니다** — 이미 차단 중인 (번호, 채널)을 다시 등록해도 에러가 아니라 기존 항목을
   * 돌려줍니다. 같은 사람이 수신거부를 두 번 요청하는 것은 정상 상황이기 때문입니다.
   */
  async create(
    params: {
      number: string;
      channel: BlockedChannel;
      source?: BlockedRecipientSource;
      sourceRef?: string;
      note?: string;
    },
    options: RequestOptions = {},
  ): Promise<BlockedRecipient> {
    const body = stripNotGiven({
      number: params.number,
      channel: params.channel,
      source: params.source,
      sourceRef: params.sourceRef,
      note: params.note,
    });
    return this._client._post(`${this._basePath}/blocked-recipients`, {
      body,
      castTo: BlockedRecipientSchema,
      ...options,
    });
  }

  /**
   * 수신거부 목록을 조회합니다. 기본은 **현재 차단 중인 항목만** 이며,
   * 해제 이력까지 보려면 `status` 를 `'released'` 또는 `'all'` 로 지정합니다.
   */
  async list(
    params: {
      channel?: BlockedChannel;
      number?: string;
      status?: BlockedRecipientStatus;
      page?: number;
      pageSize?: number;
    } = {},
    options: RequestOptions = {},
  ): Promise<Page<BlockedRecipient>> {
    const query = stripNotGiven({
      channel: params.channel,
      number: params.number,
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    });
    const path = `${this._basePath}/blocked-recipients`;
    const raw = await this._client._get(path, {
      castTo: PageSchema(BlockedRecipientSchema),
      query: Object.keys(query).length ? query : undefined,
      ...options,
    });
    const page = new Page<BlockedRecipient>(raw.data, raw.meta);
    page._setClient(this._client, path, BlockedRecipientSchema, query);
    return page;
  }

  /** 항목 상세를 조회합니다. 해제된 항목도 이력으로 남아 조회됩니다(`active: false`). */
  async retrieve(blockId: string, options: RequestOptions = {}): Promise<BlockedRecipient> {
    return this._client._get(`${this._basePath}/blocked-recipients/${blockId}`, {
      castTo: BlockedRecipientSchema,
      ...options,
    });
  }

  /**
   * 메모를 수정합니다.
   *
   * 번호와 채널은 바꿀 수 없습니다 — 바꾸면 "누가 무엇을 언제 거부했는가"라는 증빙이
   * 뒤틀립니다. 잘못 등록했다면 해제한 뒤 올바른 번호로 새로 등록하세요.
   */
  async update(
    blockId: string,
    params: { note?: string | null } = {},
    options: RequestOptions = {},
  ): Promise<BlockedRecipient> {
    return this._client._patch(`${this._basePath}/blocked-recipients/${blockId}`, {
      body: { note: params.note ?? null },
      castTo: BlockedRecipientSchema,
      ...options,
    });
  }

  /**
   * 수신거부를 해제해 다시 발신할 수 있게 합니다.
   *
   * **항목은 삭제되지 않습니다.** `active` 가 false 가 되고 `unblockedAt` 이 기록될 뿐,
   * 행은 이력으로 남습니다 — 언제 거부했고 언제 풀렸는지가 곧 증빙이기 때문입니다.
   * 해제분은 `list({ status: 'released' })` 로 볼 수 있습니다.
   *
   * 이미 해제된 항목에 다시 호출해도 성공하며, 최초 해제 시각은 덮어쓰지 않습니다.
   */
  async release(
    blockId: string,
    params: { note?: string } = {},
    options: RequestOptions = {},
  ): Promise<BlockedRecipient> {
    const body = stripNotGiven({ note: params.note });
    return this._client._deleteWithResponse(
      `${this._basePath}/blocked-recipients/${blockId}`,
      {
        body: Object.keys(body).length ? body : undefined,
        castTo: BlockedRecipientSchema,
        ...options,
      },
    );
  }
}
