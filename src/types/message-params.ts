export interface MessageCreateParams {
  to: string;
  from: string;
  body: string;
  type?: 'sms' | 'mms' | 'rcs' | 'kakao';
  subject?: string;
  mediaUrl?: string[];
}

export interface MessageListParams {
  type?: 'sms' | 'mms' | 'rcs' | 'kakao';
  status?: 'queued' | 'sending' | 'sent' | 'failed' | 'received';
  page?: number;
  pageSize?: number;
}
