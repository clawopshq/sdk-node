export interface MessageCreateParams {
  to: string;
  from: string;
  body: string;
  type?: 'sms' | 'lms' | 'mms';
  subject?: string;
  mediaUrl?: string[];
}

export interface MessageListParams {
  type?: 'sms' | 'lms' | 'mms';
  status?: 'queued' | 'sending' | 'sent' | 'failed' | 'received';
  page?: number;
  pageSize?: number;
}
