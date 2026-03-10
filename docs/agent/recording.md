# 통화 녹음

`recording: true`로 통화를 실시간 녹음할 수 있습니다.

## 설정

```typescript
import { ClawOpsAgent, OpenAIRealtime } from 'claw-ops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '상담원입니다.',
  }),
  recording: true,
  recordingPath: './recordings', // 기본값
});
```

## 생성되는 파일

통화마다 WAV 파일(PCM16 8kHz mono)이 생성됩니다.

| 파일 | 내용 |
|------|------|
| `{callId}_in.wav` | 발신자 음성 (수신 오디오) |
| `{callId}_out.wav` | AI 응답 (송신 오디오) |
| `{callId}_mix.wav` | 양방향 믹스 |

## 동작 원리

- 수신 오디오(발신자)가 타임라인 역할을 합니다
- 송신 오디오(AI 응답)는 버퍼에 쌓이고, 수신 청크가 올 때마다 같은 길이만큼 꺼내서 샘플 단위로 믹스합니다
- 파일은 실시간으로 기록되므로 통화 중 디스크에 바로 저장됩니다
- 통화 종료 시 WAV 헤더가 최종 크기로 업데이트됩니다
