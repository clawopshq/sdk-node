# VoiceML Stream WebSocket Protocol

ClawOps의 `<Connect><Stream>` VoiceML verb 또는 Agent Media WebSocket을 통해 실시간 오디오를 송수신하기 위한 WebSocket 프로토콜.

## 연결

**VoiceML Stream:**
서버가 `<Stream url="wss://your-server.com/stream">` 에 지정된 URL로 WebSocket 연결을 생성합니다.

**Agent Media:**
SDK가 `call.incoming` 이벤트의 `mediaUrl`로 WebSocket 연결을 생성합니다.

## 플랫폼 보장 사항

- **수신 오디오**: Asterisk jitter buffer가 네트워크 jitter를 흡수하여 균일한 20ms 간격으로 전달
- **송신 오디오**: 아무 타이밍으로 보내도 플랫폼이 20ms 간격으로 정규화하여 재생
- **SDK에서 pacing/jitter buffer 구현 불필요**

## 오디오 사양

| 항목 | 값 |
|------|-----|
| 인코딩 | G.711 μ-law |
| 샘플레이트 | 8000 Hz |
| 채널 | 1 (mono) |
| 프레임 크기 | 160 bytes (20ms) |
| 전송 형식 | base64 in JSON |

## 메시지 포맷

### 서버 → 클라이언트

#### connected

WebSocket 연결 성공.

```json
{
  "event": "connected",
  "protocol": "Call",
  "version": "1.0.0"
}
```

#### start

스트림 메타데이터.

```json
{
  "event": "start",
  "sequenceNumber": "1",
  "start": {
    "streamId": "MZ...",
    "callId": "CA...",
    "accountId": "AC...",
    "tracks": ["inbound"],
    "mediaFormat": {
      "encoding": "audio/x-mulaw",
      "sampleRate": 8000,
      "channels": 1
    },
    "customParameters": {}
  }
}
```

#### media

수신 오디오 (전화 → 클라이언트). G.711 μ-law base64.

```json
{
  "event": "media",
  "sequenceNumber": "3",
  "media": {
    "track": "inbound",
    "chunk": "1",
    "timestamp": "5",
    "payload": "<base64 G.711 μ-law>"
  }
}
```

#### mark

클라이언트가 보낸 mark에 대한 재생 완료 알림. 해당 mark 이전의 모든 오디오가 재생 완료되었음을 의미합니다.

```json
{
  "event": "mark",
  "sequenceNumber": "4",
  "mark": {
    "name": "greeting_end"
  }
}
```

#### stop

스트림 종료.

```json
{
  "event": "stop",
  "sequenceNumber": "5",
  "stop": {
    "accountId": "AC...",
    "callId": "CA..."
  }
}
```

### 클라이언트 → 서버

#### media

송신 오디오 (클라이언트 → 전화). G.711 μ-law base64. **아무 타이밍으로 전송 가능** — 플랫폼이 20ms 간격으로 pacing 처리합니다.

```json
{
  "event": "media",
  "media": {
    "payload": "<base64 G.711 μ-law>"
  }
}
```

#### mark

오디오 뒤에 마커를 삽입하여 재생 완료 시점을 추적합니다. media 전송 후 mark를 보내면, 해당 지점까지 오디오가 재생 완료될 때 서버가 동일한 mark를 돌려보냅니다.

```json
{
  "event": "mark",
  "mark": {
    "name": "custom-identifier"
  }
}
```

#### clear

송신 오디오 버퍼를 즉시 비웁니다 (barge-in). 대기 중인 mark가 있으면 모두 발화한 후 큐를 비웁니다.

```json
{
  "event": "clear"
}
```

## 사용 패턴

### 기본 오디오 송수신

```
클라이언트                        서버
    |                              |
    |<-- connected ----------------|
    |<-- start --------------------|
    |<-- media (수신 오디오) -------|  (20ms 간격)
    |--- media (송신 오디오) ------>|  (아무 타이밍 OK)
    |<-- media --------------------|
    |    ...                       |
    |<-- stop ---------------------|
```

### mark를 사용한 재생 완료 추적

```
클라이언트                        서버
    |                              |
    |--- media (TTS 청크 1) ------>|
    |--- media (TTS 청크 2) ------>|
    |--- mark("greeting") -------->|  (greeting 끝 지점에 마커)
    |--- media (TTS 청크 3) ------>|
    |--- mark("question") -------->|
    |    ...                       |
    |<-- mark("greeting") ---------|  (greeting까지 재생 완료)
    |    ...                       |
    |<-- mark("question") ---------|  (question까지 재생 완료)
```

### barge-in (clear)

```
클라이언트                        서버
    |                              |
    |--- media (TTS 응답) -------->|
    |--- media (TTS 응답) -------->|
    |--- mark("response") -------->|
    |--- media (TTS 응답) -------->|
    |                              |  (사용자가 말하기 시작)
    |--- clear ------------------->|  (버퍼 비움 요청)
    |<-- mark("response") ---------|  (대기 중이던 mark 발화)
    |                              |  (남은 TTS 오디오 즉시 중단)
```

## Twilio Media Streams와의 차이

| 항목 | Twilio | ClawOps |
|------|--------|---------|
| 오디오 코덱 | mulaw 8kHz | mulaw 8kHz |
| ID 필드명 | accountSid, callSid, streamSid | accountId, callId, streamId |
| DTMF 이벤트 | 지원 | 미지원 |
| VoiceML verb | `<Stream>` (TwiML) | `<Stream>` (VoiceML) |
