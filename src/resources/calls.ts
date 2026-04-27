import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import { CallSchema, CallControlResponseSchema } from '../types/call.js';
import type { Call, CallControlResponse } from '../types/call.js';
import type { CallCreateParams, CallListParams } from '../types/call-params.js';
import {
  TranscriptStatusSchema,
  TranscriptRequestAcceptedSchema,
} from '../types/transcript.js';
import type { TranscriptStatus, TranscriptRequestAccepted } from '../types/transcript.js';
import { SummaryStatusSchema } from '../types/summary.js';
import type { SummaryStatus } from '../types/summary.js';

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

  /**
   * 통화 전사 상태 조회. 완료된 경우 segment 배열까지 한 번에 반환합니다.
   *
   * @throws NotFoundError (404) — 통화 없음
   * @throws PermissionDeniedError (403) — accountId 불일치
   */
  async getTranscript(
    callId: string,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<TranscriptStatus> {
    return this._client._get(`${this._basePath}/calls/${callId}/transcript`, {
      castTo: TranscriptStatusSchema,
      ...options,
    });
  }

  /**
   * 특정 통화 1 건에 대해 전사를 명시 요청.
   * 조직 설정 "통화 받아쓰기" 가 꺼져 있어도 해당 통화만 전사됩니다.
   * 재실행 금지 — 이미 요청된 통화는 ConflictError(409) 발생.
   * 시스템 레벨 트리거 실패(stage=trigger) 만 재시도 가능.
   * 전사된 오디오 길이만큼 사용량 기반으로 과금됩니다.
   *
   * @throws BadRequestError (400) — 녹음 없음
   * @throws NotFoundError (404) — 통화 없음
   * @throws PermissionDeniedError (403) — accountId 불일치
   * @throws ConflictError (409) — 이미 요청됨
   */
  async requestTranscript(
    callId: string,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<TranscriptRequestAccepted> {
    return this._client._post(`${this._basePath}/calls/${callId}/transcript`, {
      castTo: TranscriptRequestAcceptedSchema,
      ...options,
    });
  }

  /**
   * 통화 요약 상태 조회. transcript 가 완료된 통화에 대해 자동 생성된
   * LLM 구조화 요약 결과를 반환합니다. completed 일 때 resultJson 채워짐.
   *
   * @throws NotFoundError (404) — 통화 없음
   * @throws PermissionDeniedError (403) — accountId 불일치
   */
  async getSummary(
    callId: string,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<SummaryStatus> {
    return this._client._get(`${this._basePath}/calls/${callId}/summary`, {
      castTo: SummaryStatusSchema,
      ...options,
    });
  }
}
