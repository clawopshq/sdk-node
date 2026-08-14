# Changelog

## 0.32.0 (2026-08-15)

### Added
- **`CallSession.endedDuration` — 서버가 확정한 통화 시간.** Python SDK 0.46.0 과 mirror. 종료 이벤트가 실어 보내던 값을 지금까지 SDK 가 읽지 않아, 통화 기록을 자체 시스템에 적재하려면 REST 를 다시 조회하거나 로컬 시계로 잰 값을 써야 했습니다.
  ```typescript
  agent.on('call_end', (call) => {
    console.log(call.endedStatus, call.endedDuration);  // completed 91
  });
  ```
  - `duration` 은 그대로 둡니다 — 그쪽은 **SDK 가 로컬 시계로 재는 경과 시간**이라 통화 중에도 읽힙니다. 기록·정산에 쓸 값은 `endedDuration` 입니다.
  - `call_end` 핸들러 안에서 읽을 수 있습니다. 서버는 미디어 스트림을 먼저 닫고 정리를 마친 뒤에 종료 정보를 보내므로, SDK 가 그 프레임을 **짧게 기다렸다가** `call_end` 를 발화합니다(최대 2초). 정상적인 통화에서는 밀리초 안에 끝나고, 제어 연결이 끊긴 경우에만 상한을 씁니다.
  - 서버가 값을 보내지 않으면 `null` 을 유지합니다. **서버 배포가 선행되어야** 실제 값이 들어옵니다.

## 0.31.0 (2026-08-14)

### Added
- **`transfer(to, { callerIdMode })` — 전환받는 쪽에 표시될 번호를 고릅니다.** Python SDK 0.45.0 과 mirror. 지금까지 전환은 **계정 보유번호**(인바운드면 착신 070)로 고정이었고, 원 발신자 번호를 보이게 하려면 `callerId` 에 번호를 직접 넘기는 수밖에 없었습니다.
  ```typescript
  await call.transfer('021234567', { callerIdMode: 'original' });  // 환자 번호가 데스크에 표시
  ```
  - `'original'` 은 **선호**입니다. 승계할 수 없는 통화(통신사 직결 인바운드가 아니거나 국내 번호로 정규화되지 않는 발신번호)면 조용히 계정 번호로 내려앉고 **전환은 그대로 성사됩니다**.
  - `callerId` 로 번호를 직접 주는 것은 **지시**라 성격이 다릅니다. 허용 범위(계정 보유번호 또는 그 통화의 원 발신자)를 벗어나면 전환 자체가 실패합니다.
  - 둘 다 주면 `callerId` 가 이기고 `callerIdMode` 는 무시됩니다.
  - 내장 `transfer_call` 도구에도 `caller_id_mode` 가 추가되어 AI 가 번호 대신 의도를 고를 수 있습니다.
  - 기본 동작은 바뀌지 않습니다. 지정하지 않으면 지금까지와 똑같이 계정 번호가 표시됩니다.

### Fixed
- 내장 `transfer_call` 도구가 건 전환이 실패했을 때 아무 흔적도 남지 않던 것(`.catch(() => {})`). 이제 로그에 남습니다.

## 0.30.0 (2026-08-14)

### Added
- **`calls.create({ agentId })` — 매니지드 에이전트로 발신.** Python SDK 0.42.0 과 mirror. 콘솔에서 만든 AI 에이전트에게 아웃바운드 통화를 맡긴다. REST 는 `AgentId` 를 계속 지원해 왔는데 SDK 에만 파라미터가 없어, AI Completion 모드를 걷어낸 뒤로 **SDK 로 AI 통화를 거는 방법이 `url`(VoiceML 서버 직접 구현)뿐**이었다. 그 공백을 메운다.
  - `callContext: { instruction, variables }` — **이번 통화에만** 적용되는 지시. 에이전트 자체 설정은 그대로 두고 이 통화만 다르게 행동시킨다. 같은 에이전트로 동시에 거는 다른 통화에는 영향이 없다. 파라미터는 camelCase 로 받고 본문은 PascalCase 로 보낸다(스펙이 `additionalProperties: false` 라 camelCase 를 그대로 흘리면 400).
- **`calls.create({ callFlowId, variables })` — 콜 플로우로 발신.** 콘솔 빌더로 만든 결정적 ARS 플로우가 통화를 진행한다. `variables` 는 멘트·URL·본문의 `{{이름}}` 을 치환하며 `callFlowId` 와 함께일 때만 쓸 수 있다(단독 지정 시 400). `caller`·`callee`·`recording_url`·`recording_duration`·`http_status` 는 통화 중 자동으로 채워지는 예약 변수라 지정할 수 없다.
- `url`·`agentId`·`callFlowId` 는 서로 배타적이고, **셋 다 생략하면 Agent SDK 모드**로 From 번호에 연결된 세션이 받는다.
- `CallContextParam` 타입을 export 에 추가.

## 0.28.0 (2026-07-31)

### Added
- **수신거부(DNC) 명단 리소스 — `client.blockedRecipients`.** Python SDK 0.40.0 과 mirror. 광고 문자 하단의 080 무료수신거부, ARS 의 "수신거부 9번", 상담 중 구두 요청 등으로 접수된 번호를 계정 단위로 관리한다. 등록된 번호는 그 계정의 **발신**(전화·문자)에서 제외되며 **착신은 막지 않는다** — 수신거부 접수 자체가 우리 080/ARS 로 오는 착신이기 때문이다.
  - `create({ number, channel })` — 하이픈·`+82` 표기 모두 허용되며 국내 표기로 정규화되어 저장된다. **멱등**이라 이미 차단 중인 (번호, 채널)을 다시 등록해도 에러가 아니라 기존 항목을 돌려준다(같은 사람이 수신거부를 두 번 요청하는 것은 정상 상황이다).
  - `list({ channel, number, status })` — 기본은 차단 중인 것만. `status: 'released' | 'all'` 로 해제 이력까지 조회. `number` 는 하이픈 표기로 넣어도 정규화 후 대조한다.
  - `retrieve(blockId)` / `update(blockId, { note })` — 메모만 수정한다. 번호·채널은 바꿀 수 없다(증빙이 뒤틀린다).
  - `release(blockId)` — 해제. **항목을 삭제하지 않고** `active: false` + `unblockedAt` 을 기록해 이력으로 남긴다. 언제 거부했고 언제 풀렸는지가 곧 증빙이라서다. 재호출해도 최초 해제 시각은 덮지 않는다.
  - 전화와 문자는 각각 따로 차단한다. 같은 번호라도 채널마다 별개 항목이라 둘 다 막으려면 `channel` 을 바꿔 두 번 등록한다.
- 내부: `BaseClient` 에 `_patch` / `_deleteWithResponse` 추가. 후자는 soft delete 처럼 삭제 결과 리소스를 그대로 반환하는 endpoint 용으로, 응답을 버리는 기존 `_delete` 는 그대로 둔다.

## 0.26.0 (2026-07-23)

### Removed
- **`calls.create({ ai })` — AI Completion 모드 제거.** 서버에서 해당 모드가 종료되어 `AI` 필드를 포함한 요청은 이제 `410 ai_mode_removed` 로 거절된다. `ai` 파라미터와 `AIConfig`/`OpenAIAIConfig`/`GeminiAIConfig`/`CustomAIConfig` 타입을 삭제했다. 통화에 AI 를 태우려면 **Agent SDK**(`@teamlearners/clawops/agent`) 를 쓰거나, 콘솔에서 만든 매니지드 에이전트 또는 VoiceML(`url`) 을 사용한다. Python SDK 0.38.0 과 mirror.

## 0.25.1 (2026-07-23)

### Fixed
- **발신 통화에서 `agent.tool()` 로 등록한 도구가 AI 에게 전달되지 않던 문제.** Python SDK 0.37.1 과 동일한 수정. 발신은 originate 직후 prewarm 이 돌면서 LLM 에 tool 스키마를 확정 전송하는데(OpenAI `session.update` / Gemini Live connect config), 도구 주입은 상대가 받은 뒤인 `_startCallSession` 에서야 실행됐다. 즉 **유저 도구가 통째로 빠진 채 세션이 시작**되어, 아무리 유도해도 도구가 호출되지 않았다. 착신·`PipelineSession`·`LiveKitSession` 은 영향 없음. 이제 prewarm 전에 도구를 주입한다.
- MCP 도구는 통화 시작 시점에야 registry 에 붙으므로 prewarm 스키마에 없었다. OpenAI Realtime 은 `attach()` 에서 도구가 바뀐 경우에만 `session.update` 로 재전송한다. Gemini Live 는 연결 후 도구 변경이 불가능하므로, MCP 서버가 설정돼 있으면 prewarm 을 건너뛰고 기존 `start()` 경로로 간다.
- prewarm 창(상대가 받기 전)에 내장 통화 제어 도구가 호출되면 `Unknown tool: hang_up` 이라는 엉뚱한 에러를 모델에 돌려줬다. 이제 "통화가 아직 연결되지 않았습니다" 결과를 돌려줘 모델이 응답 후 다시 호출할 수 있다.

## 0.25.0 (2026-07-22)

### Fixed
- **발신 결과가 통보되지 않던 문제.** 서버는 `call.ended` 에 종료 사유를 `status` 로 싣지만 `_handleEnded` 가 이 값을 버려서, **상대가 받지 않은 통화(무응답)가 성사된 통화와 구분되지 않았다.** `await session.wait()` 가 조용히 리턴하고 `status` 도 `ended` 라서 발신 실패를 코드로 감지할 방법이 아예 없었다.
- `CallSchema.status` 의 `z.enum` 이 `queued`/`ringing`/`in-progress`/`completed`/`failed` 5종만 허용해, 정작 진단이 필요한 **무응답·통화중·거절 통화를 `client.calls.get()` 으로 조회하면 파싱 에러**로 실패했다. 서버가 실제로 반환하는 9종 전부를 허용하도록 넓혔다.

### Added
- `CallSession.endedStatus` — 서버가 통보한 최종 종료 사유(`completed` / `no-answer` / `busy` / `rejected` / `canceled` / `failed`). 통화가 끝나기 전에는 `null`. `status` 는 상대가 받았든 아니든 `ended` 가 되므로 성사 여부는 이 값으로 판단한다. `completed` 만이 실제로 연결된 통화를 의미한다.
- `call_failed` 이벤트가 실제로 발화된다. 통화가 **연결되지 못하고** 끝났을 때 `(call, reason)` 으로 호출되며 `reason` 은 `endedStatus` 와 같다. 이전에는 서버가 보내지 않는 `call.failed` 에만 묶여 있어 영원히 호출되지 않는 죽은 API 였다. 이제 발신 한 건은 반드시 `call_start`+`call_end`(연결됨) 또는 `call_failed`(미연결) 중 한쪽으로 끝난다. Python SDK 의 동명 이벤트와 mirror.

## 0.24.0 (2026-07-17)

### Added
- **LiveKit Agents transport (실험적)** — [LiveKit Agents](https://docs.livekit.io/agents/) 로 작성한 음성 에이전트를 LiveKit 서버·SIP·room 없이 실제 ClawOps 번호로 실행한다. 유저는 관용적인 LiveKit 코드를 그대로 쓰고, ClawOps 는 전화 transport 만 공급한다 (room-less). 서브패스 export `@teamlearners/clawops/agent/livekit` 로 `LiveKitSession` 제공 — `new ClawOpsAgent({ from, session: new LiveKitSession(create) })`. `create` 팩토리가 `[AgentSession, Agent]` 를 반환하는 것이 전부이며, `Agent` 서브클래스·`llm.tool`·`onEnter`·handoff 등은 그대로 동작한다.
  - 내장 통화 제어 도구(`hang_up`/`collect_dtmf`/`send_dtmf`/`transfer_call`)를 LiveKit Toolset 으로 자동 주입(유저 도구와 이름 충돌 시 내장 쪽 제외). `transcript` 이벤트는 `conversation_item_added` 를 브리지해 네이티브 세션과 동일하게 흐른다. prewarm→attach(발신 링 구간 세션 선점)와 mark 기반 재생 완료/barge-in 절단 판정 지원.
  - `@livekit/agents` · `@livekit/rtc-node` 를 optional peer dependency 로 선언(미설치 소비자 무영향, 런타임 lazy `import`). Python SDK 의 `clawops.agent.livekit` 와 mirror. Node 18+. 동시통화 현재 1건. 문서: [`docs/agent/livekit.md`](docs/agent/livekit.md), 예제: [`examples/livekit-agent.ts`](examples/livekit-agent.ts).

## 0.23.0 (2026-07-08)

### Added
- `new ClawOpsAgent({ machineDetection })` — 인스턴스 레벨 AMD default. 생성 시 지정하면 해당 에이전트의 모든 발신에 적용된다(`'Enable'` / `'Hangup'`). `agent.call(to, { machineDetection })` 의 호출별 override 는 그대로 유지되며, 우선순위는 **호출 인자 > 인스턴스 default > 비활성**. Python SDK 의 `machine_detection` 과 mirror. 서버 동작 변화는 없다(`MachineDetection` body 필드만 조건부 포함).

## 0.22.0 (2026-07-07)

### Added
- `session.transfer(to, { destinationType })` + `transfer_call` 도구에 `destination_type`(`pstn`/`sip`) 파라미터 추가. `'sip'` 이면 `to` 를 SIP URI(`sip:user@host`)로 해석해 통화를 PSTN carrier 없이 SIP 엔드포인트로 직접 전환한다(INVITE 브릿지 — 녹음·관측 유지). 기본값 `'pstn'` (기존 전화번호 전환과 하위호환). `'sip'` 전환은 `sip_trunk` 부가서비스가 필요하며, 미보유 시 전환은 실패하고 통화는 AI 로 유지된다.

## 0.21.0 (2026-06-22)

### Added
- `numbers.update` 에 인바운드 라우팅 파라미터 추가 — `routingType`(`webhook`/`sip`/`softphone`), `sipEndpointId`, `sipCredentialId`. `softphone` 으로 등록된 SIP 단말 착신, `sip` 으로 외부 PBX 라우팅을 API 로 설정할 수 있다 (둘 다 `sip_trunk` 부가서비스 필요).
- `sipCredentials` / `sipEndpoints` 조회 전용 리소스 신설 (`list` / `get`) — softphone/sip 라우팅 설정에 필요한 id 를 조회한다. 평문 password·ha1 은 응답에 포함되지 않는다.
- `PhoneNumber` 응답 스키마에 `routingType` / `sipEndpointId` / `sipCredentialId` 필드 추가.

## 0.20.0 (2026-06-10)

### Added
- `Call.answeredBy` — AMD(`machineDetection`) 결과 필드 추가. `machineDetection` 을 켠 발신 통화에서 `human`(사람) / `machine`(자동응답기·음성사서함) / `unknown`(판정 불가) 값으로 채워진다 (`calls.get` / `calls.list` 응답). 미사용 통화는 값 없음.
- README·agent quickstart 에 `machineDetection` 사용법과 `answeredBy` / status callback `AnsweredBy` 확인 방법 문서화.

## 0.17.1 (2026-05-26)

### Fixed
- `ws` 가 optional peer dependency 로 선언되어 자동 설치되지 않아, agent 통화 시 `Cannot find package 'ws'` 런타임 오류가 발생하던 문제 수정 — `ws` 는 Control/Media WebSocket(모든 통화의 코어 경로)에서 사용하는 필수 의존성이므로 `dependencies` 로 이동.

## 0.17.0 (2026-05-26)

### Added
- **Outbound realtime prewarm** — Realtime 세션(OpenAI / Gemini)을 발신(originate) 직후 ring 구간에 미리 연결하고 greeting 오디오를 prebuffer 하여, 상대가 받는 즉시 첫 음성을 송출한다. `answer → first-audio` 지연이 약 2.6s → ~0ms(prebuffer 즉시 flush) 수준으로 단축된다.
  - `new ClawOpsAgent({ prewarmEnabled: true })` (기본값) 로 통화 단위 on/off.
  - prewarm 트리거 우선순위: `agent.call()` originate 직후(주 경로) → `call.ringing`(fallback) → `call.outbound_ready`(최종 fallback). `call.ringing` 은 트렁크가 SIP 18x 를 올리지 않으면 도착하지 않을 수 있어 신뢰하지 않는다.
  - `[PREWARM-T]` 로그 마커(start / done / attach / first-audio)로 latency 측정.

### Fixed
- prewarm 후 attach 전에 통화가 실패/종료될 때 LLM WebSocket 연결을 `session.stop()` 으로 정리하여 leak 을 방지한다 (`_prewarmAttached` 가드로 정상 통화의 이중 stop 방지). originate-time prewarm 으로 미응답/거절 통화에서도 prewarm 연결이 열리므로 필수.

### Known limitations
- `ClawOpsAgent` 1 인스턴스 = 동시 outbound 통화 1건 가정. 단일 공유 세션이므로 동시 다발 발신(같은 인스턴스)은 미지원.
