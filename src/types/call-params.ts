// ── AI Completion 타입 ───────────────────────────────────────────────────────

/** OpenAI Realtime 모델. 자유 입력도 허용. */
export type OpenAIRealtimeModel = 'gpt-realtime' | (string & {});

/** OpenAI 음성 ID. 자유 입력도 허용. */
export type OpenAIVoice =
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

/** Gemini Realtime 모델. 자유 입력도 허용. */
export type GeminiRealtimeModel = 'gemini-3.1-flash-live-preview' | (string & {});

/** Gemini 음성 ID. 자유 입력도 허용. */
export type GeminiVoice =
  | 'Puck'
  | 'Zephyr'
  | 'Kore'
  | 'Orus'
  | 'Autonoe'
  | 'Umbriel'
  | 'Erinome'
  | 'Laomedeia'
  | 'Schedar'
  | 'Achird'
  | 'Sadachbia'
  | 'Fenrir'
  | 'Aoede'
  | 'Enceladus'
  | 'Algieba'
  | 'Algenib'
  | 'Achernar'
  | 'Gacrux'
  | 'Zubenelgenubi'
  | 'Sadaltager'
  | 'Charon'
  | 'Leda'
  | 'Callirrhoe'
  | 'Iapetus'
  | 'Despina'
  | 'Rasalgethi'
  | 'Alnilam'
  | 'Pulcherrima'
  | 'Vindemiatrix'
  | 'Sulafat'
  | (string & {});

/** Provider 공통 설정 */
interface AIConfigBase {
  /** AI 제공자의 API 키. */
  apiKey: string;
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
  /** Gemini VAD 설정. @google/genai RealtimeInputConfig 구조 그대로 전달. */
  realtimeInputConfig?: Record<string, unknown>;
}

/** OpenAI provider 설정. provider: 'openai'일 때 모델과 음성이 OpenAI 전용으로 제한됨. */
export interface OpenAIAIConfig extends AIConfigBase {
  provider: 'openai';
  /** OpenAI Realtime 모델. */
  model: OpenAIRealtimeModel;
  /** OpenAI 음성 ID (기본값: 'marin'). */
  voice?: OpenAIVoice;
}

/** Gemini provider 설정. provider: 'gemini'일 때 모델과 음성이 Gemini 전용으로 제한됨. */
export interface GeminiAIConfig extends AIConfigBase {
  provider: 'gemini';
  /** Gemini Realtime 모델. */
  model: GeminiRealtimeModel;
  /** Gemini 음성 ID. */
  voice?: GeminiVoice;
}

/** 기타 provider. 자유 입력. */
export interface CustomAIConfig extends AIConfigBase {
  provider: string & {};
  model: string;
  voice?: string;
}

/**
 * AI Completion 모드 설정.
 *
 * `provider` 값에 따라 `model`과 `voice`의 자동완성이 달라집니다:
 * - `'openai'` → OpenAI 모델/음성만 표시
 * - `'gemini'` → Gemini 모델/음성만 표시
 * - 기타 → 자유 입력
 */
export type AIConfig = OpenAIAIConfig | GeminiAIConfig | CustomAIConfig;

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
  /** 발신번호로 필터링. 배열 시 IN 조건. */
  from?: string | string[];
  /** 수신번호로 필터링. 배열 시 IN 조건. */
  to?: string | string[];
  /** 관여 번호로 필터링 (from OR to 매칭). 배열 시 IN 조건. */
  number?: string | string[];
  page?: number;
  pageSize?: number;
}

export interface CallUpdateParams {
  status?: 'completed';
}
