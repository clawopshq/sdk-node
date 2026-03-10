export interface CallCreateParams {
  to: string;
  from: string;
  url: string;
  statusCallback?: string;
  statusCallbackEvent?: string;
}

export interface CallListParams {
  status?: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed';
  page?: number;
  pageSize?: number;
}

export interface CallUpdateParams {
  status?: 'completed';
}
