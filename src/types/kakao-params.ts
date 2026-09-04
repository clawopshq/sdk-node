import type { KakaoChannelStatus } from './kakao.js';

export interface KakaoChannelListParams {
  /** 미지정·`'all'` 은 전체. 그 밖의 값은 `400` 이다 — 오타가 조용히 전체 목록이 되지 않는다. */
  status?: KakaoChannelStatus | 'all';
  page?: number;
  pageSize?: number;
}

export interface KakaoTokenRequestParams {
  /** 카카오 채널 검색용 ID. `@` 를 붙여 보내도 떼어내고 처리한다. */
  searchId: string;
  /**
   * 인증번호를 받을 담당자 휴대전화번호. 하이픈·`+82` 형태 모두 허용된다.
   * **카카오 비즈니스 채널에 관리자로 등록된 번호여야** 인증번호가 발송된다.
   */
  phoneNumber: string;
}

export interface KakaoChannelConnectParams {
  /** `channels.requestToken()` 이 돌려준 정규화된 값을 그대로 보낸다. */
  searchId: string;
  /** 인증번호를 받은 담당자 휴대전화번호. 앞 단계와 같은 번호여야 한다. */
  phoneNumber: string;
  /** `channelCategories()` 응답의 `code`. */
  categoryCode: string;
  /** 담당자 휴대전화로 받은 인증번호. 저장하지 않고 확인에만 쓴다. */
  token: string;
}

export interface KakaoTemplateListParams {
  /** ClawOps 채널 리소스 ID. **필수다** — 없으면 `400` 이다. */
  channelId: string;
  page?: number;
  pageSize?: number;
}

/** 브랜드 메시지 템플릿 목록. 알림톡과 같은 축(채널 필수)이다. */
export interface KakaoBrandTemplateListParams {
  /** ClawOps 채널 리소스 ID. **필수다** — 없으면 `400` 이다. */
  channelId: string;
  page?: number;
  pageSize?: number;
}
