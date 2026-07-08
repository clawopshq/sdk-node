# Changelog

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
