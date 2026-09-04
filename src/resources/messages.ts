import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import { MessageSchema } from '../types/message.js';
import type { Message } from '../types/message.js';
import type {
  BrandSendParams,
  KakaoSendParams,
  MessageCreateParams,
  MessageListParams,
} from '../types/message-params.js';

/**
 * 알림톡·브랜드의 템플릿 지정을 서버 표기(PascalCase)로 옮긴다.
 *
 * 두 채널의 입력 모양이 같아서 한 곳에 둔다 — 서버가 `Variables` 키 이름을 바꾸면 여기만
 * 고치면 된다. 사본으로 두면 한쪽을 빠뜨려도 값이 `Record<string, unknown>` 이라 컴파일이
 * 통과한다.
 */
const templateBlock = (p?: KakaoSendParams | BrandSendParams) =>
  p && stripNotGiven({ ChannelId: p.channelId, TemplateId: p.templateId, Variables: p.variables });

export class Messages extends APIResource {
  /**
   * 문자(SMS/LMS/MMS) 또는 카카오 알림톡·브랜드 메시지를 발송합니다.
   *
   * 셋은 배타적입니다 — `kakao` 를 실으면 알림톡, `brand` 를 실으면 브랜드 메시지이고,
   * 이때 `body`·`subject`·`mediaUrl` 은 실을 수 없습니다(본문은 템플릿이 정합니다).
   *
   * ```ts
   * // 문자
   * await client.messages.create({ to: '010…', from: '070…', body: '안녕하세요' });
   *
   * // 알림톡 — 실패하면 fallback 문구가 문자로 대신 나갑니다(별도 1건으로 과금)
   * await client.messages.create({
   *   to: '010…',
   *   from: '070…',
   *   kakao: { channelId, templateId, variables: { 고객명: '홍길동' } },
   *   fallback: { body: '주문이 접수되었습니다.' },
   * });
   *
   * // 브랜드 메시지 — 채널을 추가한 친구에게 나가는 광고성 메시지
   * // ⚠️ 야간 제한과 대체발송 없음 — 제약은 `BrandMessageCreateParams` 참고.
   * await client.messages.create({
   *   to: '010…',
   *   from: '070…',
   *   brand: { channelId, templateId, variables: { 고객명: '홍길동' } },
   * });
   * ```
   */
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
      // 중첩 객체는 손으로 조립한다 — stripNotGiven 은 한 겹만 훑는다.
      Kakao: templateBlock(params.kakao),
      Brand: templateBlock(params.brand),
      Fallback:
        params.fallback &&
        stripNotGiven({
          Type: params.fallback.type,
          Subject: params.fallback.subject,
          Body: params.fallback.body,
          Disabled: params.fallback.disabled,
        }),
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
      number: params.number,
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
