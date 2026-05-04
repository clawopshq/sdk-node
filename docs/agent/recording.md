# 통화 녹음

`recording: true`로 통화를 실시간 녹음할 수 있습니다.

## 설정

```typescript
import { ClawOpsAgent, OpenAIRealtime } from '@teamlearners/clawops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '상담원입니다.',
  }),
  recording: true,
  recordingPath: './recordings', // 기본값
  rxGain: 1.0,
  txGain: 1.0,
});
```

## 생성되는 파일

통화마다 WAV 파일(PCM16 8kHz mono)이 생성됩니다.

| 파일 | 내용 |
|------|------|
| `{callId}/in.wav` | 발신자 음성 (수신 오디오) |
| `{callId}/out.wav` | AI 응답, hold audio 등 실제 송신 오디오 |
| `{callId}/mix.wav` | 양방향 믹스 |

`rxGain` 또는 `txGain`을 조정한 경우 녹음 파일에는 **게인이 적용된 후의 오디오**가 저장됩니다.
- `in.wav` = STT/LLM이 실제로 받은 caller 오디오 (rxGain 적용 후)
- `out.wav` = caller가 핸드폰으로 실제로 들은 AI 오디오 (txGain 적용 후)

따라서 녹음을 청취하면 통화 양측이 실제로 들은 음량을 그대로 검증할 수 있습니다.
원본 caller 음성을 보존하려면 `rxGain: 1.0`(기본값)을 유지하세요.

## 동작 원리

- 수신 오디오(발신자)는 `rxGain` 적용 후 세션에 전달되고 같은 오디오가 기록됩니다
- 수신 오디오의 media timestamp가 통화 타임라인 역할을 합니다
- 송신 오디오는 `txGain` 적용 후 `CallSession.sendAudio()` 직전에 가로채어 같은 타임라인에 기록합니다
- 같은 timestamp에서 연속 송신되는 청크는 오디오 길이만큼 cursor를 전진시켜 서로 겹치지 않습니다
- 파일은 실시간으로 기록되므로 통화 중 디스크에 바로 저장됩니다
- 통화 종료 시 WAV 헤더가 최종 크기로 업데이트됩니다
