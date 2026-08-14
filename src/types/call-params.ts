// ── Call API 파라미터 ────────────────────────────────────────────────────────

/**
 * `agentId` 에이전트의 **이번 통화에만** 적용되는 컨텍스트.
 *
 * 에이전트 자체의 설정은 그대로 두고 이 통화만 다르게 행동시킬 때 사용한다.
 * 같은 에이전트로 동시에 거는 다른 통화에는 영향이 없다.
 */
export interface CallContextParam {
  /** 이번 통화에서 수행할 실행 요구사항 (최대 4000자). */
  instruction: string;
  /** 요구사항에서 참조할 통화별 구조화 데이터 (최대 50개). */
  variables?: Record<string, string | number | boolean>;
}

/**
 * 발신 전화 생성 요청 파라미터.
 *
 * **4가지 모드** — `url`, `agentId`, `callFlowId` 는 서로 배타적이다.
 *
 * - **VoiceML 모드**: `url` 을 지정하면 VoiceML 로 통화를 제어한다.
 * - **매니지드 에이전트 모드**: `agentId` 를 지정하면 콘솔에서 만든 AI 에이전트가
 *   통화를 처리한다. `callContext` 로 이번 통화만의 지시를 덧붙일 수 있다.
 * - **콜 플로우 모드**: `callFlowId` 를 지정하면 결정적 ARS 플로우가 진행한다.
 *   `variables` 로 시작 변수를 넘긴다.
 * - **Agent SDK 모드**: 셋 다 생략하면 From 번호에 연결된 Agent SDK 로 연결된다.
 */
export interface CallCreateParams {
  to: string;
  from: string;
  /** VoiceML 명령을 반환할 URL. `agentId`·`callFlowId` 와 배타. */
  url?: string;
  /** 콘솔에서 만든 매니지드 에이전트 ID. `url`·`callFlowId` 와 배타. */
  agentId?: string;
  /** `agentId` 에이전트의 이번 통화에만 적용되는 컨텍스트. */
  callContext?: CallContextParam;
  /** 콜 플로우(결정적 ARS) ID. `url`·`agentId` 와 배타. */
  callFlowId?: string;
  /**
   * 콜 플로우 시작 변수. 멘트·URL·본문의 `{{이름}}` 이 이 값으로 치환된다.
   * `callFlowId` 와 함께일 때만 쓸 수 있다(단독 지정 시 400).
   * `caller`·`callee`·`recording_url`·`recording_duration`·`http_status` 는
   * 통화 중 자동으로 채워지는 예약 변수라 지정할 수 없다.
   */
  variables?: Record<string, string | number | boolean>;
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
