export interface MessageCreateParams {
  to: string;
  from: string;
  body: string;
  type?: 'sms' | 'lms' | 'mms';
  subject?: string;
  mediaUrl?: string[];
  /**
   * 발송 멱등키. 같은 계정에서 같은 키로 다시 요청하면 발송하지 않고 1회차 결과를 돌려준다.
   * 재시도·재실행 경로가 있는 호출자만 채운다.
   *
   * ⚠️ 순차 재시도를 막는 용도다. 같은 키로 **동시에** 두 요청이 들어오면 둘 다 발송될 수 있다.
   */
  idempotencyKey?: string;
}

export interface MessageListParams {
  type?: 'sms' | 'lms' | 'mms';
  status?: 'queued' | 'sending' | 'sent' | 'failed' | 'received';
  page?: number;
  pageSize?: number;
}
