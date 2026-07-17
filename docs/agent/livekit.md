# LiveKit Agents 실행 (실험적)

[LiveKit Agents](https://docs.livekit.io/agents/) 로 작성한 음성 에이전트를 **LiveKit
서버도 SIP 도 없이** 실제 ClawOps 전화번호로 실행합니다.

> 실험적 기능이라 API 가 바뀔 수 있고, 동시통화는 현재 1건입니다.

## 설치

```bash
npm i @teamlearners/clawops
npm i @livekit/agents @livekit/rtc-node
npm i @livekit/agents-plugin-openai @livekit/agents-plugin-cartesia   # 쓰는 플러그인만
```

`@livekit/rtc-node` 는 네이티브 애드온(prebuilt binary)이라 `@livekit/agents` 와 함께
optional peer dependency 로만 선언됩니다 — LiveKit 을 쓰지 않는 소비자에게는 설치되지
않습니다. Node 18+ 필요.

## 예제

```ts
import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as cartesia from '@livekit/agents-plugin-cartesia';

import { ClawOpsAgent } from '@teamlearners/clawops/agent';
import { LiveKitSession } from '@teamlearners/clawops/agent/livekit';
import type { LiveKitCreateFn } from '@teamlearners/clawops/agent/livekit';

const create: LiveKitCreateFn = async (call) => {   // 통화당 1회 호출
  const session = new voice.AgentSession({
    llm: new openai.realtime.RealtimeModel({ modalities: ['text'] }),
    tts: new cartesia.TTS({ model: 'sonic-3.5', language: 'ko' }),
  });
  return [session, new voice.Agent({ instructions: '당신은 친절한 예약 상담원입니다.' })];
};

const agent = new ClawOpsAgent({ from: '07012341234', session: new LiveKitSession(create) });
await agent.serve();   // 착신 대기. 발신은 await agent.call(to)
```

`create` 가 `[AgentSession, Agent]` 를 반환하는 것이 전부입니다. `Agent` 서브클래스,
[`llm.tool`](https://docs.livekit.io/agents/build/tools/), `onEnter`, handoff 등 LiveKit
코드는 그대로 씁니다. 전체 스크립트: [`examples/livekit-agent.ts`](../../examples/livekit-agent.ts).

## 무엇이 되고 안 되나

ClawOps 는 room 없는 transport 라, LiveKit 기능 중 room/서버에 묶인 것은 안 됩니다.

| | |
|---|---|
| ✅ **그대로** | `Agent` 서브클래스(`onEnter`/`llm.tool`/handoff/`llmNode`·`ttsNode` 오버라이드) · `AgentSession(...)` · `RunContext`(`userData`) · `generateReply`/`say`/`session.on(...)` · `silero.VAD` · Cartesia·Deepgram 등 HTTP 플러그인 |
| 🔧 **한 줄 수정** | `session.start({ room })` → `room` 을 빼세요. ClawOps 가 `start()` 를 대신 부릅니다 |
| ⚠️ **LiveKit 키 필요** | `inference.STT/LLM/TTS` 는 LiveKit Cloud 를 호출합니다. 없이 쓰려면 `openai.LLM(...)`/`cartesia.TTS(...)` 로 provider 직접 지정 |
| ❌ **불가** | `noiseCancellation.BVC()` · `ctx.api.*` · `ctx.waitForParticipant()` · `RoomInputOptions`/`RoomOutputOptions` · LiveKit SIP 기반 warm transfer/AMD · 아바타 |

## 알아둘 점

- **통화 제어 도구** `hang_up`/`collect_dtmf`/`send_dtmf`/`transfer_call` 이 자동
  주입됩니다. `ClawOpsAgent({ builtinTools })` 로 켜고 끄며, 유저 도구와 이름이 겹치면
  내장 쪽을 뺍니다. `transfer_call` 은 ClawOps 전환(PSTN/SIP)을 씁니다.
- **`modalities: ['text']` 인데 `tts` 가 없으면** 소리가 안 납니다. ClawOps 는 이 경우
  시작 시점에 에러를 던집니다.
- **transcript** 는 네이티브 세션과 동일하게 `agent.on('transcript', (call, role, text) => …)`
  로 최종 발화가 들어옵니다 (LiveKit `conversation_item_added` 를 브리지). 단, room-less
  경로에서는 LiveKit 자신도 transcription sync 를 생략하므로, barge-in 시 잘린 발화가
  전체 텍스트로 기록될 수 있습니다.
- **녹음·telemetry** 는 LiveKit `record` 가 아니라 ClawOps 자체 기능을 씁니다 (미디어
  레이어에서 세션 무관하게 동작).
- **동시통화 1건** — 현재는 한 번에 한 통화만 처리합니다.
