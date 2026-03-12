# 아키텍처

## 전체 구조

```
ClawOpsAgent
├── connect()              # Control WS 연결 (논블로킹)
├── serve()                # connect + 시그널 대기 + auto disconnect
├── disconnect()           # 연결 해제
├── call(to)               # 발신 (auto connect)
│
├── ControlWebSocket        # 서버 연결 (상시, auto-reconnect)
│   ├── call.incoming       # 인바운드 콜 알림 수신
│   ├── call.outbound_ready # 아웃바운드 콜 미디어 준비
│   └── call.ended          # 콜 종료 알림 수신
│
├── MediaWebSocket (콜별)   # 오디오 스트리밍 (VoiceML Stream Protocol)
│   ├── start               # 미디어 스트림 시작
│   ├── media               # G.711 μ-law 8kHz base64 오디오
│   ├── mark                # 재생 완료 추적
│   ├── clear               # 버퍼 flush (barge-in)
│   └── stop                # 미디어 스트림 종료
│
├── OpenAIRealtime (콜별)   # OpenAI Realtime API
│   ├── session.update      # 세션 설정 (음성, 도구 등)
│   ├── audio bridging      # G.711 μ-law 네이티브 지원
│   ├── tool calls          # 등록된 함수 자동 호출
│   └── truncation          # 인터럽트 처리
│
├── GeminiRealtime (콜별)   # Google Gemini Live API
│   ├── setup/setupComplete # 세션 초기화
│   ├── audio bridging      # G.711 μ-law ↔ PCM16 16kHz/24kHz 변환
│   ├── tool calls          # 등록된 함수 자동 호출 (⚠ Known Issue 참고)
│   └── barge-in            # 자동 인터럽트 처리
│   # ⚠ function calling + 실시간 오디오 시 1008 에러 가능 (Google 서버 이슈)
│
├── PipelineSession (콜별)  # STT → LLM → TTS (파이프라인 모드)
│   ├── STT loop            # 오디오 → SpeechEvent
│   ├── LLM generate        # 메시지 → 텍스트 스트림
│   ├── TTS synthesize      # 텍스트 → 오디오 스트림
│   ├── barge-in            # VAD 기반 인터럽트
│   └── tool calls          # Chat Completions 포맷 처리
│
├── ToolRegistry            # agent.tool() 함수 관리
│   ├── register            # 함수 등록
│   ├── toOpenAITools()     # JSON Schema 자동 생성
│   ├── fork()              # 콜별 복사 (MCP 도구 격리)
│   └── call()              # 이름으로 함수 호출
│
├── AudioRecorder (콜별)    # 실시간 녹음 (recording: true 시)
│   ├── writeInbound()      # 수신 오디오 → _in.wav + _mix.wav
│   ├── writeRawOutbound()  # 송신 오디오 → _out.wav + mix 버퍼
│   └── stop()              # WAV 헤더 업데이트
│
├── CallSession (콜별)      # 통화 상태 관리
│   ├── sendAudio()         # 응답 오디오 전송
│   ├── clearAudio()        # 오디오 버퍼 클리어
│   ├── hangup()            # 통화 종료
│   └── wait()              # 통화 종료까지 대기
│
└── MCPClient (콜별)        # MCP 서버 연동
    ├── connect()           # 서버 연결 + tools/list
    ├── callTool()          # tools/call
    └── close()             # 연결 종료
```

## 세션 타입

`ClawOpsAgent`의 `session` 옵션으로 세션 타입을 지정합니다:

```typescript
// OpenAI Realtime API
session: new OpenAIRealtime({ systemPrompt: '...' })

// Google Gemini Live API
session: new GeminiRealtime({ systemPrompt: '...' })

// Pipeline (STT + LLM + TTS)
session: new PipelineSession({ stt: ..., llm: ..., tts: ... })
```

## 오디오 코덱 체인

```
전화 (G.711 μ-law 8kHz)
    ↕ ulawToPcm16 / pcm16ToUlaw
PCM16 8kHz
    ↕ resamplePcm16
PCM16 16kHz (STT 입력) / PCM16 24kHz (TTS 출력)
```

## Control WebSocket 재연결

- 초기 대기: 1초
- 최대 대기: 30초
- 지수 백오프: `delay = min(delay * 2, 30)`

## 보안 모델

- **인증**: Bearer 토큰 (API 키) + TLS 암호화
- **번호 소유권 검증**: API 키 → 계정 → 번호 소유 확인
- **미디어 토큰**: 1회용 토큰 (30초 만료), Control WS를 통해 발급
- **Webhook 서명 불필요**: Agent가 서버에 직접 연결하므로 별도 서명 검증 없음

## 환경변수

| 변수 | 설명 | 필수 여부 |
|------|------|-----------|
| `CLAWOPS_API_KEY` | ClawOps API 키 (`sk_...`) | 예 |
| `CLAWOPS_ACCOUNT_ID` | 계정 ID (`AC...`) | 예 |
| `OPENAI_API_KEY` | OpenAI API 키 | OpenAI Realtime 사용 시 |
| `GOOGLE_API_KEY` | Google API 키 | Gemini Realtime 사용 시 |
| `DEEPGRAM_API_KEY` | Deepgram API 키 | DeepgramSTT 사용 시 |
| `ELEVENLABS_API_KEY` | ElevenLabs API 키 | ElevenLabsTTS 사용 시 |
| `CLAWOPS_BASE_URL` | API 기본 URL | 아니오 |
