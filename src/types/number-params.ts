export interface NumberCreateParams {
  webhookUrl?: string;
}

export interface NumberUpdateParams {
  webhookUrl?: string;
  webhookMethod?: 'POST' | 'GET';
  /** inbound 라우팅: webhook | sip | softphone. */
  routingType?: 'webhook' | 'sip' | 'softphone';
  /** routingType='sip' 일 때 라우팅할 SipEndpoint id. */
  sipEndpointId?: string | null;
  /** routingType='softphone' 일 때 착신할 등록 SIP credential(단말) id. */
  sipCredentialId?: string | null;
}
