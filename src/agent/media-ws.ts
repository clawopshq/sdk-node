import { MediaProfile, mediaContract, validateMediaFormat } from './media-profile.js';
/**
 * Media WebSocket for streaming audio to/from the telephony platform.
 *
 * ClawOps VoiceML Stream protocol:
 * connected -> start -> media (G.711 ulaw 8kHz base64) -> mark -> stop
 */

import type { WebSocket as WsType } from 'ws';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from './logger.js';

export interface MediaStartEvent {
  streamId: string;
  callId: string;
  accountId: string;
  sampleRate: number;
}

export interface MediaEvent {
  audio: Buffer;
  timestamp: number;
}

export interface DtmfEvent {
  digit: string;
  track: string;
}

/**
 * Parse a 'start' event payload from the media WebSocket.
 */
export function parseStartEvent(data: Record<string, unknown>): MediaStartEvent {
  const start = data['start'] as Record<string, unknown>;
  const fmt = (start['mediaFormat'] ?? {}) as Record<string, unknown>;
  return {
    streamId: (start['streamId'] ?? '') as string,
    callId: (start['callId'] ?? '') as string,
    accountId: (start['accountId'] ?? '') as string,
    sampleRate: (fmt['sampleRate'] ?? 8000) as number,
  };
}

/**
 * Parse a 'media' event payload.
 */
export function parseMediaEvent(data: Record<string, unknown>): MediaEvent {
  const media = data['media'] as Record<string, unknown>;
  return {
    audio: Buffer.from((media['payload'] ?? '') as string, 'base64'),
    timestamp: parseInt((media['timestamp'] as string) ?? '0', 10) || 0,
  };
}

/**
 * Build a media response message to send audio back.
 */
export function buildMediaResponse(audioBase64: string): string {
  return JSON.stringify({
    event: 'media',
    media: {
      payload: audioBase64,
    },
  });
}

const VALID_DTMF_DIGITS = new Set('0123456789*#');

export function parseDtmfEvent(data: Record<string, unknown>): DtmfEvent {
  const dtmf = data['dtmf'] as Record<string, unknown>;
  return {
    digit: (dtmf['digit'] ?? '') as string,
    track: (dtmf['track'] ?? '') as string,
  };
}

export function buildDtmfMessage(digit: string): string {
  if (!VALID_DTMF_DIGITS.has(digit)) {
    throw new Error(`유효하지 않은 DTMF digit: ${digit}`);
  }
  return JSON.stringify({ event: 'dtmf', dtmf: { digit } });
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 공개 호스트로 가는 `ws://` 면 경고한다 — 연결은 막지 않는다(로컬 하네스는 평문을 쓴다). */
export function warnIfPlaintext(url: string, log: Pick<Logger, 'warn'>): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol === 'ws:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    log.warn(
      'Media WS URL is plaintext (ws://%s); the call token travels unencrypted. ClawOps sends wss:// URLs — check what rewrote this one.',
      parsed.hostname,
    );
  }
}

/** 로그용 — 1회용 `token` 이 쿼리에 실려 있으므로 쿼리·프래그먼트를 뗀다. */
function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

/** 재생 끝 mark 를 보내기 전에 새 오디오가 이만큼 안 들어와야 한다(조각 TTS 대비). */
export const PLAYOUT_QUIET_MS = 300;

export class MediaWebSocket {
  private _ws: WsType | null = null;
  private _audioQueue: string[] = [];
  private _sendLoopRunning = false;
  private _closed = false;
  private _onAudio: ((audio: Buffer, timestamp: number) => void) | null = null;
  private _onStart: ((event: MediaStartEvent) => void) | null = null;
  private _onClose: (() => void) | null = null;
  private _onDtmf: ((digit: string) => void) | null = null;
  private _markWaiters: Map<string, () => void> = new Map();
  /** 마지막으로 오디오를 큐에 넣은 시각(ms). 재생 끝 판정의 「조용한 구간」 기준. */
  private _lastAudioAt = 0;
  private _log: Logger = NOOP_LOGGER;

  private _formatValidated: boolean;
  constructor(private readonly options: { expectedMediaProfile?: MediaProfile } = {}) {
    if (options.expectedMediaProfile !== undefined) mediaContract(options.expectedMediaProfile);
    this._formatValidated = options.expectedMediaProfile === undefined;
  }

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  /** Set the handler for inbound audio data. */
  onAudio(handler: (audio: Buffer, timestamp: number) => void): void {
    this._onAudio = handler;
  }

  /** Set the handler for the start event. */
  onStart(handler: (event: MediaStartEvent) => void): void {
    this._onStart = handler;
  }

  /** Set the handler for connection close. */
  onClose(handler: () => void): void {
    this._onClose = handler;
  }

  /** Set the handler for inbound DTMF events. */
  onDtmf(handler: (digit: string) => void): void {
    this._onDtmf = handler;
  }

  /** Send a single DTMF digit to the platform. */
  sendDtmf(digit: string): void {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(buildDtmfMessage(digit));
    }
  }

  /** Whether the WebSocket is connected. */
  get isConnected(): boolean {
    return this._ws !== null && this._ws.readyState === 1 && !this._closed;
  }

  /**
   * Connect to a media WebSocket URL.
   *
   * 인증은 서버가 준 URL 의 1회용 `token` 하나다. 두 번째 인자(API 키)는 호환을 위해 받기만 하고
   * 쓰지 않는다 — 예전엔 `Authorization: Bearer` 로 실었지만 서버는 그 헤더를 읽은 적이 없고,
   * 서버가 `ws://` 를 주던 동안엔 계정 API 키가 평문 첫 요청에 실려 나갔다(clawops#1250).
   */
  async connect(url: string, _apiKey?: string): Promise<void> {
    // Format admission belongs to this connection, not a previous successful peer.
    // The legacy/default transport remains ready immediately, as before.
    this._formatValidated = this.options.expectedMediaProfile === undefined;
    const { WebSocket } = await import('ws');
    warnIfPlaintext(url, this._log);

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { followRedirects: true });
      this._ws = ws;
      this._closed = false;

      ws.on('open', () => {
        this._startSendLoop();
        resolve();
        this._log.info('Media WS connected: %s', stripQuery(url));
      });

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this._handleMessage(msg);
        } catch {
          // Ignore parse errors
        }
      });

      ws.on('close', () => {
        this._closed = true;
        if (this._onClose) {
          this._onClose();
        }
      });

      ws.on('error', (err: Error) => {
        if (!this._ws) {
          reject(err);
        }
        this._log.error({ err }, 'Media WS error');
      });
    });
  }

  /** Queue base64-encoded audio for sending. */
  sendAudio(audioBase64: string): void {
    this._lastAudioAt = Date.now();
    this._audioQueue.push(audioBase64);
  }

  /** Clear all queued outbound audio. */
  sendClear(): void {
    this._audioQueue.length = 0;
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify({ event: 'clear' }));
    }
  }

  /** Send a mark event. */
  sendMark(name: string): void {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(
        JSON.stringify({
          event: 'mark',
          mark: { name },
        }),
      );
    }
  }

  /** Wait for all queued audio to be sent. */
  flush(): Promise<void> {
    if (this._audioQueue.length === 0 || this._closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this._audioQueue.length === 0 || this._closed) {
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
      setTimeout(check, 5);
    });
  }

  /** Wait for a named mark to be echoed back by the server. */
  waitForMark(name: string, timeoutMs = 5000): Promise<void> {
    if (this._closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this._markWaiters.delete(name);
        resolve();
      }, timeoutMs);
      this._markWaiters.set(name, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * 지금까지 보낸 오디오가 발신자에게 다 재생될 때까지 기다린다. 재생 끝 echo 를 받았으면 `true`.
   *
   * 서버는 mark 앞의 오디오를 RTP 로 다 내보낸 뒤 mark 를 돌려주고, `clear` 때는 남은 mark 를
   * 즉시 돌려준다(Twilio Media Streams 와 같은 의미). 그래서 순서가 중요하다.
   * - 오디오는 송신 큐를 거치고 mark 는 바로 나가므로, 큐를 먼저 비워야 mark 가 오디오를 앞지르지 않는다.
   * - 오디오가 조각조각 이어서 들어오는 중이면(TTS 를 만들면서 흘려 보내는 경로) 큐가 잠깐 빈 틈을
   *   재생 끝으로 보게 된다. 새 오디오가 {@link PLAYOUT_QUIET_MS} 동안 안 들어온 뒤에 보낸다.
   * - 재생할 게 없으면 echo 가 곧장 오므로 waiter 를 **보내기 전에** 건다.
   *
   * `signal` 이 abort 되면(먼저 키가 눌렸을 때) 기다림을 접고 `false` 를 돌려준다 — 타이머가
   * 남아 이벤트 루프를 붙잡지 않게.
   */
  async waitPlayedOut(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this._closed || !this.isConnected) return false;
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    for (;;) {
      if (signal?.aborted || this._closed) return false;
      await this.flush();
      const quietFor = Date.now() - this._lastAudioAt;
      if (quietFor >= PLAYOUT_QUIET_MS || Date.now() >= deadline) break;
      await sleep(PLAYOUT_QUIET_MS - quietFor);
    }
    if (signal?.aborted || this._closed) return false;

    const name = `playout-${Math.random().toString(36).slice(2, 14)}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (echoed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._markWaiters.delete(name);
        resolve(echoed && !this._closed);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', () => finish(false), { once: true });
      this._markWaiters.set(name, () => finish(true));
      this.sendMark(name);
    });
  }

  /** Close the media WebSocket. */
  close(): void {
    this._closed = true;
    // 기다리던 mark 는 이제 안 온다 — 상한까지 붙잡지 말고 깨운다.
    for (const resolve of [...this._markWaiters.values()]) resolve();
    this._markWaiters.clear();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const event = msg['event'] as string;

    switch (event) {
      case 'start': {
        if (this.options.expectedMediaProfile !== undefined) {
          try {
            validateMediaFormat(this.options.expectedMediaProfile,
              ((msg['start'] as Record<string, unknown>)?.['mediaFormat'] ?? {}) as Record<string, unknown>);
            this._formatValidated = true;
          } catch {
            this.close();
            return;
          }
        }
        const startEvt = parseStartEvent(msg);
        if (this._onStart) {
          this._onStart(startEvt);
        }
        break;
      }
      case 'media': {
        if (!this._formatValidated) { this.close(); return; }
        const mediaEvt = parseMediaEvent(msg);
        if (this._onAudio) {
          this._onAudio(mediaEvt.audio, mediaEvt.timestamp);
        }
        break;
      }
      case 'dtmf': {
        const dtmfEvt = parseDtmfEvent(msg);
        if (this._onDtmf) {
          this._onDtmf(dtmfEvt.digit);
        }
        break;
      }
      case 'mark': {
        const markName = (msg['mark'] as Record<string, unknown>)?.['name'] as string;
        if (markName) {
          const resolve = this._markWaiters.get(markName);
          if (resolve) {
            this._markWaiters.delete(markName);
            resolve();
          }
        }
        break;
      }
      case 'stop': {
        this.close();
        break;
      }
    }
  }

  private _startSendLoop(): void {
    if (this._sendLoopRunning) return;
    this._sendLoopRunning = true;

    const loop = () => {
      if (this._closed) {
        this._sendLoopRunning = false;
        return;
      }

      while (this._formatValidated && this._audioQueue.length > 0 && this._ws && this._ws.readyState === 1) {
        const payload = this._audioQueue.shift()!;
        this._ws.send(buildMediaResponse(payload));
      }

      setTimeout(loop, 20);
    };

    loop();
  }
}
