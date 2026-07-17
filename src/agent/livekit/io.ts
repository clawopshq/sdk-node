/**
 * LiveKit AudioInput/AudioOutput <-> ClawOps Media WS 브리지.
 *
 * LiveKit 의 AgentSession 은 room 없이도 동작한다 — `session.input.audio` /
 * `session.output.audio` 에 커스텀 구현을 꽂으면 된다. 이 모듈이 그 구현이다.
 *
 * 전화망 wire format 은 G.711 μ-law 8kHz, 160바이트(20ms) 프레임이다. AudioOutput 이
 * `sampleRate=8000` 을 선언하므로 프레임워크가 TTS 출력을 8kHz 로 리샘플해준다 —
 * 우리는 μ-law 인코딩만 한다.
 *
 * 참조 구현: agents-js `voice/console_io.ts` 의 `TcpAudioInput`/`TcpAudioOutput` —
 * 같은 문제(비-WebRTC transport 를 AgentSession 에 물리기)를 푸는 LiveKit 자신의 코드다.
 * ⚠️ Python(clawops-python) 과 달리 agents-js 는 `AudioInput` 베이스와
 * `TranscriptionSynchronizer` 를 public export 하지 않는다. 그래서
 *   - AudioInput 은 구조적으로 구현(ReadableStream 노출)하고,
 *   - 재생 완료(playout) 판정은 `TcpAudioOutput` 과 동일한 Future 핸드셰이크로 하되
 *     완료 신호를 Media WS `mark` echo 로 받는다. (LiveKit 자신의 `AgentsConsole` 도
 *     room-less 경로에서 transcription sync 를 생략하므로 우리도 생략한다.)
 *
 * ⚠️ AudioOutput 계약 2가지 — 어기면 조용히 깨진다:
 * 1. 첫 프레임에서 `onPlaybackStarted()` 를 반드시 호출한다. 빼면 assistant 메시지가
 *    히스토리에서 통째로 사라진다.
 * 2. `onPlaybackFinished()` 는 flush 세그먼트당 정확히 한 번, 취소되더라도 반드시
 *    호출한다. 안 그러면 프레임워크의 재생 회계가 어긋나 wait_for_playout 이 영구 대기한다.
 */

import { pcm16ToUlaw, DECODE_TABLE } from '../audio.js';
import type { CallSession } from '../session.js';

export const SAMPLE_RATE = 8000;
/** 전화망 wire rate. AudioOutput 이 선언하면 프레임워크가 여기 맞춰 리샘플한다. */

export const FRAME_BYTES = 160;
/** μ-law 20ms = 160바이트. */

export const ULAW_SILENCE_BYTE = 0xff;
/** μ-law 무음 — 마지막 프레임 패딩용. */

const MARK_TIMEOUT_MARGIN_MS = 10_000;
/** mark 대기 timeout = 밀어넣은 오디오 길이(ms) + 이 여유. */

/** ClawOpsAudioOutput 이 오디오를 흘려보내는 대상(실 통화 또는 prewarm 버퍼)의 최소 계약. */
interface AudioSink {
  sendAudio(audio: Buffer): void | Promise<void>;
  clearAudio(): void;
}

/** 외부에서 참조할 인스턴스 타입 (실제 클래스는 optional dep 로드 후 팩토리에서 정의된다). */
export interface ClawOpsAudioInputInstance {
  readonly stream: unknown;
  pushUlaw(ulaw: Buffer): void;
  endInput(): void;
  close(): Promise<void>;
  onAttached(): void;
  onDetached(): void;
}

export interface ClawOpsAudioOutputInstance {
  setCall(call: CallSession): void;
  close(): void;
  // AudioOutput 상속 메서드(captureFrame/flush/clearBuffer/onPlaybackStarted/...)는
  // 프레임워크가 호출하므로 여기 노출하지 않는다.
}

export interface ClawOpsIO {
  ClawOpsAudioInput: new () => ClawOpsAudioInputInstance;
  ClawOpsAudioOutput: new (call: AudioSink) => ClawOpsAudioOutputInstance;
}

/** 외부 resolve 를 노출하는 1회성 Deferred (agents-js 의 non-exported `Future` 대응). */
class Deferred<T = void> {
  readonly promise: Promise<T>;
  private _resolve!: (value: T) => void;
  private _done = false;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this._resolve = resolve;
    });
  }
  get done(): boolean {
    return this._done;
  }
  resolve(value: T): void {
    if (this._done) return;
    this._done = true;
    this._resolve(value);
  }
}

let _cached: ClawOpsIO | null = null;

/**
 * agents-js / rtc-node 를 동적 로드해 IO 클래스를 정의한다 (1회 캐시).
 *
 * 클래스가 `voice.AudioOutput`(optional dep)을 상속하므로 top-level 이 아니라
 * import 성공 후 팩토리 안에서 정의해야 한다.
 */
export async function loadClawOpsIO(): Promise<ClawOpsIO> {
  if (_cached) return _cached;

  // 두 optional dep 를 병렬 로드한다 (독립적, boot 1회).
  const [agents, rtc] = (await Promise.all([
    import('@livekit/agents'),
    import('@livekit/rtc-node'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ])) as [any, any];

  // agents-js 는 AudioOutput 생성자(instance-init)에서 log() 를 부르고, 로거가 초기화되지
  // 않았으면 throw 한다. room-less 는 worker/cli(initializeLogger 를 대신 부르는)를 거치지
  // 않으므로 우리가 초기화한다 — 단, 유저가 이미 했으면(loggerOptions() 존재) 건드리지 않는다.
  if (
    typeof agents.initializeLogger === 'function' &&
    (typeof agents.loggerOptions !== 'function' || !agents.loggerOptions())
  ) {
    agents.initializeLogger({ pretty: false, level: process.env['LIVEKIT_LOG_LEVEL'] ?? 'info' });
  }

  const AudioOutputBase = agents.voice.AudioOutput;
  const AudioFrame = rtc.AudioFrame;

  /**
   * 통화 인바운드 오디오(μ-law) -> rtc.AudioFrame 스트림.
   *
   * agents-js `AudioInput` 은 public export 되지 않으므로 상속하지 않고, 프레임워크가
   * 실제로 읽는 계약(`.stream` + onAttached/onDetached/close)만 구조적으로 구현한다.
   * `session.input.audio = <this>` 로 꽂으면 프레임워크가 `.stream` 을 소비한다.
   */
  class ClawOpsAudioInput implements ClawOpsAudioInputInstance {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _controller: ReadableStreamDefaultController<any> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly _stream: ReadableStream<any>;
    private _closed = false;

    constructor() {
      this._stream = new ReadableStream({
        start: (c) => {
          this._controller = c;
        },
        cancel: () => {
          this._closed = true;
        },
      });
    }

    get stream(): unknown {
      return this._stream;
    }

    /** G.711 μ-law 청크를 PCM16 프레임으로 바꿔 스트림에 밀어넣는다. */
    pushUlaw(ulaw: Buffer): void {
      if (this._closed || !this._controller || ulaw.length === 0) return;
      // μ-law 를 곧장 Int16Array 로 디코드한다 (중간 Buffer + 재읽기 루프 생략).
      const samples = new Int16Array(ulaw.length);
      for (let i = 0; i < ulaw.length; i++) {
        samples[i] = DECODE_TABLE[ulaw[i]!]!;
      }
      const frame = new AudioFrame(samples, SAMPLE_RATE, 1, samples.length);
      try {
        this._controller.enqueue(frame);
      } catch {
        // 스트림이 이미 닫혔다 — 무시.
      }
    }

    /** 스트림 종료 — 리더가 완료를 본다. */
    endInput(): void {
      this._closeStream();
    }

    async close(): Promise<void> {
      this._closeStream();
    }

    onAttached(): void {}
    onDetached(): void {}

    private _closeStream(): void {
      if (this._closed) return;
      this._closed = true;
      try {
        this._controller?.close();
      } catch {
        // 이미 닫힘.
      }
    }
  }

  /**
   * AgentSession 출력 -> μ-law 160바이트 프레임 -> CallSession.sendAudio().
   *
   * 재생 완료 판정은 Media WS `mark` 로 한다 — 플랫폼이 큐의 오디오를 다 내보낸 뒤
   * mark 를 에코한다. prewarm 중(BufferingCall)에는 media WS 가 없으므로 attach 될
   * 때까지 기다렸다가 fence 를 건다(그 전엔 아직 아무것도 재생되지 않는다).
   *
   * 구조는 agents-js `TcpAudioOutput` 을 따르고, 재생 완료 신호만 broker 대신 mark 로 받는다.
   */
  class ClawOpsAudioOutput extends AudioOutputBase implements ClawOpsAudioOutputInstance {
    private _call: AudioSink;
    private _pushedDurationMs = 0;
    private _captureStartedAt = 0;
    private _tail: Buffer = Buffer.alloc(0);
    private _flushPromise: Promise<void> | null = null;
    private _flushInProgress = false;
    private _interrupted = new Deferred();
    private _attached = new Deferred();
    private _markSeq = 0;
    private _closed = false;

    constructor(call: AudioSink) {
      // AudioOutput(sampleRate?, nextInChain?, capabilities?)
      super(SAMPLE_RATE, undefined, { pause: false });
      this._call = call;
    }

    /**
     * attach() 시 실제 CallSession 으로 교체한다 (prewarm -> 실제 통화).
     *
     * prewarm 중 버퍼링된 오디오는 지금부터 실제 재생되므로 경과 기준점을 여기로 옮긴다 —
     * 안 그러면 링 구간까지 "재생됐다"고 계산돼 barge-in 절단 위치가 뒤로 밀린다.
     */
    setCall(call: CallSession): void {
      this._call = call as unknown as AudioSink;
      if (this._pushedDurationMs > 0) {
        this._captureStartedAt = Date.now();
      }
      this._attached.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async captureFrame(frame: any): Promise<void> {
      // ⚠️ close() 후엔 base 를 건드리지 않는다 — super.captureFrame 이 세그먼트 카운트를
      //    올린 뒤 여기서 bail 하면 onPlaybackFinished 가 안 나가 teardown 시 wait 이 샌다.
      if (this._closed) return;
      await super.captureFrame(frame);

      // 이전 세그먼트 flush 가 진행 중이면 기다린다 (TcpAudioOutput 과 동일).
      if (this._flushInProgress && this._flushPromise) {
        await this._flushPromise;
      }

      if (this._pushedDurationMs === 0) {
        this._captureStartedAt = Date.now();
        // ⚠️ 계약 1: 빼면 assistant 메시지가 히스토리에서 사라진다.
        this.onPlaybackStarted(Date.now());
      }

      this._pushedDurationMs += (frame.samplesPerChannel / frame.sampleRate) * 1000;

      // frame.data 는 Int16Array(PCM16). LE 플랫폼에서 그대로 바이트 뷰로 읽는다.
      const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      const encoded = pcm16ToUlaw(pcm);
      // 대부분의 프레임은 160바이트 정렬돼 tail 이 비어 있다 — 그때는 concat(추가 할당+복사)을 건너뛴다.
      const ulaw = this._tail.length === 0 ? encoded : Buffer.concat([this._tail, encoded]);
      let off = 0;
      while (off + FRAME_BYTES <= ulaw.length) {
        await this._call.sendAudio(ulaw.subarray(off, off + FRAME_BYTES));
        off += FRAME_BYTES;
      }
      this._tail = Buffer.from(ulaw.subarray(off));
    }

    flush(): void {
      super.flush();
      if (this._pushedDurationMs > 0) {
        this._interrupted = new Deferred();
        this._flushInProgress = true;
        this._flushPromise = this._runPlayoutHandshake().finally(() => {
          this._flushInProgress = false;
        });
      } else {
        this._tail = Buffer.alloc(0);
      }
    }

    clearBuffer(): void {
      // ⚠️ 여기서 onPlaybackFinished 를 부르지 않는다 — 핸드셰이크가 interrupted 를
      //    보고 한 번만 쏜다.
      this._tail = Buffer.alloc(0);
      if (this._pushedDurationMs > 0) {
        this._interrupted.resolve();
      }
      // prewarm 중이면 BufferingCall.clearAudio 가 버퍼를 비우고, 실 통화면 media WS 큐를 flush.
      this._call.clearAudio();
    }

    /** 세션 종료 시 남은 대기를 깨워 정리한다. */
    close(): void {
      this._closed = true;
      this._interrupted.resolve();
      this._attached.resolve();
    }

    // ── 내부 ───────────────────────────────────────────────────

    /** 실 통화이고 transport 가 살아 있으면 mark 훅을 가진 CallSession 을 돌려준다. */
    private _mediaCall(): CallSession | null {
      const c = this._call as unknown as {
        _sendMark?: unknown;
        _waitForMark?: unknown;
        _flushTransport?: unknown;
        _isTransportConnected?: () => boolean;
      };
      if (
        typeof c._sendMark !== 'function' ||
        typeof c._waitForMark !== 'function' ||
        typeof c._flushTransport !== 'function'
      ) {
        return null; // BufferingCall(prewarm) 또는 아직 미바인딩.
      }
      if (typeof c._isTransportConnected === 'function' && !c._isTransportConnected()) {
        return null; // WS 사망.
      }
      return this._call as unknown as CallSession;
    }

    /** `p` 와 barge-in 중 먼저 오는 걸 기다린다. 반환: p 가 이겼는가(=중단 아님). */
    private async _race(p: Promise<unknown>): Promise<boolean> {
      const winner = await Promise.race([
        p.then(() => 'main' as const),
        this._interrupted.promise.then(() => 'interrupt' as const),
      ]);
      return winner === 'main';
    }

    private async _runPlayoutHandshake(): Promise<void> {
      let interrupted = true;
      try {
        // 남은 자투리를 무음으로 패딩해 한 프레임으로 내보낸다.
        const tail = this._tail;
        this._tail = Buffer.alloc(0);
        if (tail.length > 0) {
          const padded = Buffer.concat([
            tail,
            Buffer.alloc(FRAME_BYTES - tail.length, ULAW_SILENCE_BYTE),
          ]);
          await this._call.sendAudio(padded);
        }
        interrupted = await this._awaitPlayout();
      } catch {
        // WS 사망 등 전송 오류 — interrupted 로 처리하고 프레임워크로 전파하지 않는다.
        interrupted = true;
      } finally {
        // ⚠️ 계약 2: 세그먼트당 정확히 한 번 — 취소되더라도 반드시 emit.
        const played = interrupted
          ? Math.min(Math.max(0, Date.now() - this._captureStartedAt), this._pushedDurationMs)
          : this._pushedDurationMs;
        this.onPlaybackFinished({ playbackPosition: played / 1000, interrupted });
        this._pushedDurationMs = 0;
        this._interrupted = new Deferred();
      }
    }

    /** 재생이 끝나거나 barge-in 될 때까지 대기. 반환: interrupted 여부. */
    private async _awaitPlayout(): Promise<boolean> {
      let media = this._mediaCall();
      if (!media) {
        // prewarm — 아직 재생 주체가 없다. attach 될 때까지 기다렸다가 fence 를 건다.
        if (!(await this._race(this._attached.promise))) {
          return true; // attach 전에 중단됐다.
        }
        media = this._mediaCall();
        if (!media) {
          return this._interrupted.done; // attach 됐는데도 WS 가 없다 — fence 불가.
        }
      }

      // send_mark 는 즉시 나가지만 send_audio 는 로컬 큐에 쌓인다. flush 로 큐를 비우지
      // 않으면 mark 가 오디오를 추월한다.
      await media._flushTransport!();
      const markName = `lk-${this._markSeq++}`;
      media._sendMark!(markName);
      const timeout = Math.round(this._pushedDurationMs) + MARK_TIMEOUT_MARGIN_MS;
      // mark echo(재생 완료)와 barge-in 중 먼저 오는 것을 기다린다.
      return !(await this._race(media._waitForMark!(markName, timeout)));
    }
  }

  _cached = { ClawOpsAudioInput, ClawOpsAudioOutput };
  return _cached;
}
