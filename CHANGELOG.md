# Changelog

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
