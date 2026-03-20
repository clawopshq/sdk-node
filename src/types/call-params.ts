// ── AI Completion 타입 ───────────────────────────────────────────────────────

/** 지원 AI 제공자. 자유 입력도 허용. */
export type AIProvider = 'openai' | 'gemini' | (string & {});

/** OpenAI Realtime 모델. 자유 입력도 허용. */
export type OpenAIRealtimeModel =
  | 'gpt-realtime-1.5'
  | 'gpt-4o-mini-realtime'
  | (string & {});

/** Gemini Realtime 모델. 자유 입력도 허용. */
export type GeminiRealtimeModel =
  | 'gemini-2.5-flash-native-audio-preview'
  | (string & {});

/** AI 음성 ID. 자유 입력도 허용. */
export type AIVoice =
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'fable'
  | 'marin'
  | 'sage'
  | 'shimmer'
  | 'verse'
  | (string & {});

export interface AIConfig {
  /** AI 제공자. */
  provider: AIProvider;
  /** 사용할 AI 모델명. */
  model: OpenAIRealtimeModel | GeminiRealtimeModel;
  /** AI 제공자의 API 키. */
  apiKey: string;
  /** 음성 ID (기본값: 'marin'). */
  voice?: AIVoice;
  /** 언어 코드 (기본값: 'ko'). */
  language?: string;
  /** 초기 메시지 (system prompt 등). OpenAI Chat Completions 형식. */
  messages?: Array<{ role: 'system' | 'user'; content: string }>;
  /** Function calling 도구 정의. OpenAI 형식. */
  tools?: Array<Record<string, unknown>>;
  /** 통화 시작 시 AI가 먼저 인사할지 여부 (기본값: true). */
  greeting?: boolean;
  /** 턴 감지 설정 (기본값: semantic_vad medium). */
  turnDetection?: Record<string, unknown>;
}

// ── Call API 파라미터 ────────────────────────────────────────────────────────

export interface CallCreateParams {
  to: string;
  from: string;
  /** VoiceML 명령을 반환할 URL. AI 모드와 동시 사용 불가. */
  url?: string;
  /** AI Completion 모드 설정. 이 필드가 있으면 AI가 통화를 처리합니다. */
  ai?: AIConfig;
  statusCallback?: string;
  statusCallbackEvent?: string;
  /** 발신 타임아웃 (초). 기본값: 60. */
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
