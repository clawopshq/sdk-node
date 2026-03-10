export interface NumberCreateParams {
  webhookUrl?: string;
}

export interface NumberUpdateParams {
  webhookUrl?: string;
  webhookMethod?: 'POST' | 'GET';
}
