import type { RoutingType } from './number.js';

export interface NumberCreateParams {
  /** 수신 전화 처리용 Webhook URL. */
  webhookUrl?: string;
  /** Webhook 호출 HTTP 메서드. */
  webhookMethod?: 'POST' | 'GET';
  /** Webhook 호출 시 덧붙일 헤더. 키는 'X-' 로 시작해야 한다. */
  webhookHeaders?: Record<string, string>;
  /** 수신(inbound) 통화 상태 통지 URL. */
  statusCallback?: string;
  /** 구독할 상태 이벤트(공백 구분). 미지정 시 'initiated ringing answered completed'. */
  statusCallbackEvents?: string;
}

export interface NumberUpdateParams {
  /** 착신 라우팅 모드. */
  routingType?: RoutingType;
  /** routingType='agent' 일 때 필수. 같은 계정의 에이전트 id. */
  agentId?: string | null;
  /** routingType='callflow' 일 때 필수. 같은 계정의 콜 플로우 id. */
  callFlowId?: string | null;
  /** routingType='forward' 일 때 필수. 같은 계정이 보유한 번호. */
  forwardTo?: string | null;
  /** routingType='sip' 일 때 필수. SipEndpoint id. */
  sipEndpointId?: string | null;
  /** routingType='softphone' 일 때 필수. 등록 단말의 SIP credential id. */
  sipCredentialId?: string | null;
  /** 수신 전화 처리용 Webhook URL. */
  webhookUrl?: string;
  /** Webhook 호출 HTTP 메서드. */
  webhookMethod?: 'POST' | 'GET';
  /** Webhook 호출 시 덧붙일 헤더. */
  webhookHeaders?: Record<string, string> | null;
  /** routingType='agent' 에서 통화별 컨텍스트를 조회할 endpoint. */
  callContextUrl?: string | null;
  /** 수신(inbound) 통화 상태 통지 URL. */
  statusCallback?: string | null;
  /** 구독할 상태 이벤트(공백 구분). */
  statusCallbackEvents?: string | null;
  /** 이 번호의 통화 전사에 적용할 받아쓰기 사전 id. */
  dictionaryId?: string | null;
}
