export interface AIConfig {
  provider: 'openai' | 'gemini';
  model: string;
  apiKey: string;
  voice?: string;
  language?: string;
  messages?: Array<{ role: 'system' | 'user'; content: string }>;
  tools?: Array<Record<string, unknown>>;
  greeting?: boolean;
  turnDetection?: Record<string, unknown>;
}

export interface CallCreateParams {
  to: string;
  from: string;
  url?: string;
  ai?: AIConfig;
  statusCallback?: string;
  statusCallbackEvent?: string;
  timeout?: number;
}

export interface CallListParams {
  status?: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed';
  page?: number;
  pageSize?: number;
}

export interface CallUpdateParams {
  status?: 'completed';
}
