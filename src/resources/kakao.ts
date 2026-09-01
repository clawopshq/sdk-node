import type { APIClient } from '../base-client.js';
import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import {
  KakaoChannelSchema,
  KakaoChannelCategoryListSchema,
  KakaoTemplateSchema,
  KakaoTokenRequestSchema,
} from '../types/kakao.js';
import type {
  KakaoChannel,
  KakaoChannelCategoryList,
  KakaoTemplate,
  KakaoTokenRequest,
} from '../types/kakao.js';
import type {
  KakaoChannelConnectParams,
  KakaoChannelListParams,
  KakaoTemplateListParams,
  KakaoTokenRequestParams,
} from '../types/kakao-params.js';

type RequestOptions = {
  extraHeaders?: Record<string, string>;
  extraQuery?: Record<string, unknown>;
  timeout?: number;
};

/**
 * 카카오 비즈니스 채널.
 *
 * 채널 연결은 두 단계다 — `requestToken()` 으로 담당자 휴대전화에 인증번호를 보내고,
 * 받은 번호를 `connect()` 에 실어 완료한다. 서버는 그 사이 상태를 저장하지 않으므로
 * `searchId` 와 `phoneNumber` 를 두 번 모두 보낸다.
 */
export class KakaoChannels extends APIResource {
  /**
   * 연결된 채널 목록.
   *
   * **카카오 쪽 상태를 확인하지 않는다** — 저장된 연결 정보를 그대로 돌려주므로 빠르다.
   * 실제 채널 상태까지 확인하려면 `retrieve()` 를 쓴다.
   */
  async list(
    params: KakaoChannelListParams = {},
    options: RequestOptions = {},
  ): Promise<Page<KakaoChannel>> {
    const query = stripNotGiven({
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    });
    const path = `${this._basePath}/kakao/channels`;
    const raw = await this._client._get(path, {
      castTo: PageSchema(KakaoChannelSchema),
      query: Object.keys(query).length ? query : undefined,
      ...options,
    });
    const page = new Page<KakaoChannel>(raw.data, raw.meta);
    page._setClient(this._client, path, KakaoChannelSchema, query);
    return page;
  }

  /**
   * 채널 하나를 조회한다. **목록과 달리 카카오 쪽 상태를 실제로 확인하고 `status` 를 갱신한다.**
   *
   * `connect()` 가 타임아웃됐을 때 결과를 확정하는 경로이기도 하다 — 연결을 재호출하면 중복
   * 등록을 시도하게 되지만 이 조회는 몇 번을 불러도 안전하다.
   *
   * 카카오 쪽 조회에 실패해도 `404` 가 아니다. 연결 기록은 유효하므로 `status` 가
   * `needs_attention` 으로 온다.
   */
  async retrieve(channelId: string, options: RequestOptions = {}): Promise<KakaoChannel> {
    return this._client._get(`${this._basePath}/kakao/channels/${channelId}`, {
      castTo: KakaoChannelSchema,
      ...options,
    });
  }

  /**
   * 채널 권한을 증명할 인증번호를 **담당자 휴대전화로 발송**해 달라고 요청한다. 연결의 첫 단계다.
   *
   * 응답에 인증번호는 없다(`202`). 받은 번호는 `connect()` 의 `token` 으로 보내며, 유효 시간이
   * 있으므로 받은 뒤 바로 진행한다. 재요청이 잦으면 `429 KAKAO_RATE_LIMITED` 이고
   * 응답의 `retryAfterSeconds` 만큼 기다린다.
   */
  async requestToken(
    params: KakaoTokenRequestParams,
    options: RequestOptions = {},
  ): Promise<KakaoTokenRequest> {
    return this._client._post(`${this._basePath}/kakao/channels/token`, {
      body: { searchId: params.searchId, phoneNumber: params.phoneNumber },
      castTo: KakaoTokenRequestSchema,
      ...options,
    });
  }

  /**
   * 인증번호로 채널 연결을 완료한다. **먼저 `requestToken()` 을 불러야 한다.**
   *
   * **멱등이다** — 이미 이 계정에 연결된 채널이면 인증번호를 소모하지 않고 기존 연결을 돌려준다.
   * 다른 계정에 연결된 채널은 멱등이 아니라 충돌이라 `409 KAKAO_CHANNEL_ALREADY_LINKED` 다.
   *
   * ⚠️ **타임아웃되면 재호출하지 말 것.** 이미 연결에 성공했을 수 있어 중복 등록을 시도하게 된다.
   * `list()` 나 `retrieve()` 로 실제 등록 여부를 확인한 뒤 결과를 확정한다.
   *
   * ⚠️ **실패해도 인증번호는 소모된다**(`422 KAKAO_TOKEN_INVALID`·`KAKAO_CHANNEL_REJECTED`).
   * 원인을 해결한 뒤 `requestToken()` 부터 다시 시작해야 한다.
   */
  async connect(
    params: KakaoChannelConnectParams,
    options: RequestOptions = {},
  ): Promise<KakaoChannel> {
    return this._client._post(`${this._basePath}/kakao/channels`, {
      body: {
        searchId: params.searchId,
        phoneNumber: params.phoneNumber,
        categoryCode: params.categoryCode,
        token: params.token,
      },
      castTo: KakaoChannelSchema,
      ...options,
    });
  }

  /**
   * 채널 연동을 해제한다. 카카오톡 채널 자체는 지워지지 않고 ClawOps 와의 연동만 끊긴다.
   *
   * ⚠️ **되돌릴 수 없고, 그 채널에 등록된 알림톡 템플릿도 함께 삭제된다.** 템플릿은 카카오
   * 검수를 다시 받아야 하므로 복구에 시간이 걸린다 — 호출 전에 사용자 확인을 받을 것.
   *
   * 해제 후에는 그 채널을 다시 연결할 수 있다(본인이든 다른 계정이든). `requestToken()` 부터
   * 다시 시작하면 된다.
   */
  async disconnect(channelId: string, options: RequestOptions = {}): Promise<KakaoChannel> {
    return this._client._deleteWithResponse(`${this._basePath}/kakao/channels/${channelId}`, {
      castTo: KakaoChannelSchema,
      ...options,
    });
  }
}

/** 알림톡 템플릿(읽기 전용). 등록·검수는 콘솔에서 한다. */
export class KakaoTemplates extends APIResource {
  /**
   * 한 채널의 알림톡 템플릿 목록.
   *
   * 응답의 `data[].id` 를 발송의 `kakao.templateId` 로, `data[].channelId` 를
   * `kakao.channelId` 로 쓴다. **`sendable: true` 인 템플릿만 발송할 수 있고**,
   * `variables` 의 모든 항목을 발송 요청의 `kakao.variables` 에 채워야 한다.
   */
  async list(
    params: KakaoTemplateListParams,
    options: RequestOptions = {},
  ): Promise<Page<KakaoTemplate>> {
    const query = stripNotGiven({
      channelId: params.channelId,
      page: params.page,
      pageSize: params.pageSize,
    });
    const path = `${this._basePath}/kakao/templates`;
    const raw = await this._client._get(path, {
      castTo: PageSchema(KakaoTemplateSchema),
      query,
      ...options,
    });
    const page = new Page<KakaoTemplate>(raw.data, raw.meta);
    page._setClient(this._client, path, KakaoTemplateSchema, query);
    return page;
  }
}

/**
 * 카카오 알림톡 관련 리소스.
 *
 * 발송 자체는 `client.messages.create({ kakao: … })` 다 — 여기서 얻은 채널·템플릿 ID 를 그대로 쓴다.
 */
export class Kakao {
  private _client: APIClient;
  private _accountId: string;

  constructor(client: APIClient, accountId: string) {
    this._client = client;
    this._accountId = accountId;
  }

  get channels(): KakaoChannels {
    return new KakaoChannels(this._client, this._accountId);
  }

  get templates(): KakaoTemplates {
    return new KakaoTemplates(this._client, this._accountId);
  }

  /**
   * 채널 연결 시 지정할 업종 카테고리 목록.
   *
   * **값을 코드에 하드코딩하지 말 것** — 카카오/공급자 쪽에서 늘거나 바뀌는 열린 집합이고
   * 이 응답이 그때그때의 정본이다. 응답의 `code` 를 `channels.connect()` 의 `categoryCode`
   * 로 그대로 보낸다.
   *
   * 페이지네이션이 없어 `Page` 가 아니라 `{ data, meta }` 를 그대로 돌려준다.
   */
  async channelCategories(options: RequestOptions = {}): Promise<KakaoChannelCategoryList> {
    return this._client._get(`/v1/accounts/${this._accountId}/kakao/channel-categories`, {
      castTo: KakaoChannelCategoryListSchema,
      ...options,
    });
  }
}
