/**
 * ClawOps × LiveKit Agents transport (실험적).
 *
 * LiveKit Agents 로 작성한 음성 에이전트를 LiveKit 서버·SIP·room 없이 실제 ClawOps
 * 번호로 실행한다. 유저는 관용적인 LiveKit 코드를 그대로 쓰고, ClawOps 는 전화 transport
 * 만 공급한다 (room-less).
 *
 * 필수 의존성 (직접 설치):
 *   npm i @livekit/agents @livekit/rtc-node
 * LLM/STT/TTS 플러그인도 직접 설치한다:
 *   npm i @livekit/agents-plugin-openai @livekit/agents-plugin-cartesia  # 등
 *
 * @example
 * import { LiveKitSession } from '@teamlearners/clawops/agent/livekit';
 * import { voice } from '@livekit/agents';
 * import * as openai from '@livekit/agents-plugin-openai';
 *
 * const session = new LiveKitSession(async (call) => {
 *   const s = new voice.AgentSession({ llm: new openai.realtime.RealtimeModel() });
 *   return [s, new voice.Agent({ instructions: '...' })];
 * });
 * const agent = new ClawOpsAgent({ from: '07012341234', session });
 */

export { LiveKitSession } from './session.js';
export type { LiveKitCreateFn } from './session.js';
export { createClawOpsPhoneTools } from './toolset.js';
export type { ClawOpsPhoneTools } from './toolset.js';
export { loadClawOpsIO, SAMPLE_RATE, FRAME_BYTES } from './io.js';
export type {
  ClawOpsIO,
  ClawOpsAudioInputInstance,
  ClawOpsAudioOutputInstance,
} from './io.js';
