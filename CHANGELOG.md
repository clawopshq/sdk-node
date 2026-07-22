# Changelog

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
