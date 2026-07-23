// ── Call API 파라미터 ────────────────────────────────────────────────────────

export interface CallCreateParams {
  to: string;
  from: string;
  /** VoiceML 명령을 반환할 URL. */
  url?: string;
  statusCallback?: string;
  statusCallbackEvent?: string;
  /** 발신 타임아웃 (초). 기본값: 60. */
  timeout?: number;
  /**
   * 자동응답기/음성사서함 감지(AMD). `'Enable'`=감지 후 `AnsweredBy` 통보(통화 계속),
   * `'Hangup'`=음성사서함 감지 시 자동 종료. 미설정 시 비활성.
   */
  machineDetection?: 'Enable' | 'Hangup';
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
