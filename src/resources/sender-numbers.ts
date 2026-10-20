import { APIResource } from '../resource.js';
import { SenderNumberListSchema, SenderNumberSchema } from '../types/sender-number.js';
import type { SenderNumber, SenderNumberList } from '../types/sender-number.js';

type RequestOptions = {
  extraHeaders?: Record<string, string>;
  extraQuery?: Record<string, unknown>;
  timeout?: number;
};

/**
 * 문자 발신번호 리소스(clawops#1489).
 *
 * 문자(SMS·LMS·MMS)는 계정에 등록해 승인된 발신번호로만 보낼 수 있습니다. 승인되지 않은 번호를
 * `from` 으로 보내면 `400 from_not_registered` 로 거절됩니다.
 *
 * 번호를 발급(`numbers.create()`)하면 회선 수 한도 안에서 자동으로 등록되며, 결과는 발급 응답의
 * `smsSender` 에 실립니다.
 *
 * ⚠️ 발신번호 범위를 지정한 API 키는 조회만 됩니다 — 등록·삭제는 `403 api_key_sender_numbers_restricted`.
 */
export class SenderNumbers extends APIResource {
  /**
   * 등록된 발신번호(승인·승인 대기), 유예 기간인 번호, 070번호·대표번호 회선 수 한도를 함께 돌려줍니다.
   * 발신번호 범위를 지정한 API 키로 호출하면 그 범위 안의 번호만 보입니다.
   */
  async list(options: RequestOptions = {}): Promise<SenderNumberList> {
    return this._client._get(`${this._basePath}/sender-numbers`, {
      castTo: SenderNumberListSchema,
      ...options,
    });
  }

  /**
   * 이 계정이 ClawOps에서 개통한 070번호·대표번호를 발신번호로 등록합니다. 등록 즉시 승인됩니다.
   *
   * - 한 번에 한 번호씩 등록합니다. 하이픈·`+82` 표기도 받습니다.
   * - 이미 등록된 번호면 `409 sender_number_already_registered` — 이미 발송에 쓸 수 있는 상태입니다.
   * - 명의별 회선 수 한도를 넘으면 `422 sender_number_limit_reached`.
   */
  async create(params: { number: string }, options: RequestOptions = {}): Promise<SenderNumber> {
    return this._client._post(`${this._basePath}/sender-numbers`, {
      body: { number: params.number },
      castTo: SenderNumberSchema,
      ...options,
    });
  }

  /**
   * 발신번호를 삭제합니다. 그 번호로는 바로 문자를 보낼 수 없고(유예도 함께 끝남) 회선 수 한도에서
   * 빠집니다. 번호 자체는 반납되지 않습니다.
   *
   * API 로는 ClawOps에서 개통한 번호(`verificationMethod === 'own_provisioned'`)만 삭제할 수 있습니다 —
   * 그 밖은 `409 sender_number_not_deletable_via_api`(콘솔에서 삭제).
   */
  async delete(senderNumberId: string, options: RequestOptions = {}): Promise<void> {
    await this._client._delete(`${this._basePath}/sender-numbers/${senderNumberId}`, options);
  }
}
