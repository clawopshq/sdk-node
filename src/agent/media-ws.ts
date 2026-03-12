/**
 * Media WebSocket for streaming audio to/from the telephony platform.
 *
 * ClawOps VoiceML Stream protocol:
 * connected -> start -> media (G.711 ulaw 8kHz base64) -> mark -> stop
 */

import type { WebSocket as WsType } from 'ws';

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

  /** Connect to a media WebSocket URL with Bearer authentication. */
  async connect(url: string, apiKey: string): Promise<void> {
    const { WebSocket } = await import('ws');

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        followRedirects: true,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      this._ws = ws;
      this._closed = false;

      ws.on('open', () => {
        this._startSendLoop();
        resolve();
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
        console.error('[MediaWebSocket] Error:', err.message);
      });
    });
  }

  /** Queue base64-encoded audio for sending. */
  sendAudio(audioBase64: string): void {
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

  /** Close the media WebSocket. */
  close(): void {
    this._closed = true;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const event = msg['event'] as string;

    switch (event) {
      case 'start': {
        const startEvt = parseStartEvent(msg);
        if (this._onStart) {
          this._onStart(startEvt);
        }
        break;
      }
      case 'media': {
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

      while (this._audioQueue.length > 0 && this._ws && this._ws.readyState === 1) {
        const payload = this._audioQueue.shift()!;
        this._ws.send(buildMediaResponse(payload));
      }

      setTimeout(loop, 20);
    };

    loop();
  }
}
