/**
 * LiveKit Agents 를 ClawOps 전화망에서 실행하는 로컬 테스트 스크립트.
 *
 * LiveKit 서버도 SIP 도 없이, 관용적인 LiveKit 코드를 실제 ClawOps 번호에 얹는다.
 *
 * ── 설치 ──────────────────────────────────────────────────────────
 *     npm i @teamlearners/clawops
 *     npm i @livekit/agents @livekit/rtc-node
 *     npm i @livekit/agents-plugin-openai          # realtime 모델
 *     npm i @livekit/agents-plugin-xai             # xAI TTS 를 쓸 때
 *     npm i @livekit/agents-plugin-cartesia        # Cartesia TTS 를 쓸 때
 *
 * ── 환경변수 ──────────────────────────────────────────────────────
 *     export CLAWOPS_API_KEY="sk_..."         # 필수
 *     export CLAWOPS_ACCOUNT_ID="AC..."        # 필수
 *     export CLAWOPS_FROM="07012341234"        # 필수 (에이전트가 받을/걸 번호)
 *     export OPENAI_API_KEY="sk-..."           # 필수 (realtime 모델)
 *     export XAI_API_KEY="xai-..."             # 선택 (있으면 음색을 xAI TTS 로)
 *     export CARTESIA_API_KEY="sk_car_..."     # 선택 (있으면 음색을 Cartesia 로)
 *     export CLAWOPS_TO="01012345678"          # 선택 (없으면 착신 대기)
 *
 * ── 실행 ──────────────────────────────────────────────────────────
 *     npx tsx examples/livekit-agent.ts
 *
 *     - CLAWOPS_TO 가 없으면: 착신 대기(serve). CLAWOPS_FROM 번호로 전화를 걸면 응답한다.
 *     - CLAWOPS_TO 가 있으면: 그 번호로 발신한다.
 *
 * 음색 선택 우선순위: XAI_API_KEY → CARTESIA_API_KEY → (둘 다 없으면) OpenAI realtime
 * 이 음성을 직접 낸다. TTS 를 쓰는 경우 realtime 모델은 텍스트만 만든다.
 */

import { z } from 'zod';
import { voice, llm } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';

import { ClawOpsAgent, BuiltinTool } from '@teamlearners/clawops/agent';
import { LiveKitSession } from '@teamlearners/clawops/agent/livekit';
import type { LiveKitCreateFn } from '@teamlearners/clawops/agent/livekit';

// ── 유저 도구: 관용적인 LiveKit llm.tool 이 그대로 동작한다 ──

const getBusinessHours = llm.tool({
  description: '영업 시간을 알려준다.',
  parameters: z.object({
    day: z.string().describe("요일 (예: '월요일', '토요일')"),
  }),
  execute: async ({ day }: { day: string }) => {
    if (day === '토요일' || day === '일요일') {
      return `${day}은 휴무입니다.`;
    }
    return `${day}은 오전 9시부터 오후 6시까지 영업합니다.`;
  },
});

// ── 유저 Agent 서브클래스: onEnter 인사말 ──────────────────────

class ReceptionAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        "당신은 '클로숍 카페'의 친절한 전화 상담원입니다. " +
        '손님의 문의(영업시간, 예약 등)에 짧고 자연스럽게 응대하세요. ' +
        '대화가 끝나면 hang_up 도구로 통화를 종료하세요.',
      tools: { get_business_hours: getBusinessHours },
    });
  }

  async onEnter(): Promise<void> {
    // session.start() 안에서 호출된다 — 첫 인사를 만든다.
    this.session.generateReply({
      instructions: '전화를 받았음을 알리고 무엇을 도와드릴지 물어보세요.',
    });
  }
}

// ── 통화당 1회: [AgentSession, Agent] 를 만든다 ──────────────────

const create: LiveKitCreateFn = async (_call) => {
  let session: voice.AgentSession;
  if (process.env['XAI_API_KEY']) {
    const xai = await import('@livekit/agents-plugin-xai');
    // realtime 은 텍스트만, 음성은 xAI TTS(iris)가 낸다.
    session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({ modalities: ['text'] }),
      tts: new xai.TTS({ voice: 'iris', language: 'ko' }),
    });
    console.info('세션: OpenAI realtime(text) + xAI TTS(iris)');
  } else if (process.env['CARTESIA_API_KEY']) {
    const cartesia = await import('@livekit/agents-plugin-cartesia');
    session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({ modalities: ['text'] }),
      tts: new cartesia.TTS({
        model: 'sonic-3.5',
        language: 'ko',
        voice: '4dd4630e-19e0-4243-bca0-676ff85119b7',
      }),
    });
    console.info('세션: OpenAI realtime(text) + Cartesia TTS');
  } else {
    // OpenAI realtime 이 음성을 직접 낸다.
    session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({ voice: 'marin' }),
    });
    console.info('세션: OpenAI realtime(audio)');
  }

  return [session, new ReceptionAgent()];
};

async function main(): Promise<void> {
  const fromNumber = process.env['CLAWOPS_FROM'];
  if (!fromNumber) {
    throw new Error('CLAWOPS_FROM 환경변수를 설정하세요 (에이전트 번호).');
  }

  const agent = new ClawOpsAgent({
    from: fromNumber,
    session: new LiveKitSession(create),
    builtinTools: BuiltinTool.HANG_UP, // 이 예제는 hang_up 만 켠다
  });

  agent.on('call_start', (call) => {
    console.info(`통화 시작: ${call.fromNumber} -> ${call.toNumber}`);
  });
  agent.on('call_end', (call) => {
    console.info(`통화 종료: ${call.callId} (${call.duration.toFixed(1)}s)`);
  });
  agent.on('transcript', (_call, role: string, text: string) => {
    // LiveKit 세션이어도 네이티브와 동일하게 최종 발화가 여기로 들어온다.
    console.info(`[transcript] ${role}: ${text}`);
  });

  const toNumber = process.env['CLAWOPS_TO'];
  if (toNumber) {
    console.info(`아웃바운드: ${toNumber} 로 발신합니다...`);
    try {
      const call = await agent.call(toNumber); // call() 이 내부적으로 connect 한다
      await call.wait(); // 통화가 끝날 때까지 대기
    } finally {
      await agent.disconnect();
    }
  } else {
    console.info(`착신 대기: ${fromNumber} 로 전화를 거세요. (Ctrl+C 로 종료)`);
    await agent.serve();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
