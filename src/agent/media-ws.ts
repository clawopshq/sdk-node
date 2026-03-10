/**
 * Media WebSocket for streaming audio to/from the telephony platform.
 */

import type { WebSocket as WsType } from 'ws';

export interface MediaStartEvent {
  streamSid: string;
  callSid: string;
  accountSid: string;
  tracks: string[];
  customParameters: Record<string, string>;
  mediaFormat: {
    encoding: string;
    sampleRate: number;
    channels: number;
  };
}

export interface MediaEvent {
  track: string;
  chunk: string;
  timestamp: string;
}

/**
 * Parse a 'start' event payload from the media WebSocket.
 */
export function parseStartEvent(data: Record<string, unknown>): MediaStartEvent {
  const start = data['start'] as Record<string, unknown>;
  return {
    streamSid: (start['streamSid'] ?? data['streamSid'] ?? '') as string,
    callSid: (start['callSid'] ?? '') as string,
    accountSid: (start['accountSid'] ?? '') as string,
    tracks: (start['tracks'] ?? []) as string[],
    customParameters: (start['customParameters'] ?? {}) as Record<string, string>,
    mediaFormat: (start['mediaFormat'] ?? {
      encoding: 'audio/x-mulaw',
      sampleRate: 8000,
      channels: 1,
    }) as MediaStartEvent['mediaFormat'],
  };
}

/**
 * Parse a 'media' event payload.
 */
export function parseMediaEvent(data: Record<string, unknown>): MediaEvent {
  const media = data['media'] as Record<string, unknown>;
  return {
    track: (media['track'] ?? 'inbound') as string,
    chunk: (media['chunk'] ?? media['payload'] ?? '') as string,
    timestamp: (media['timestamp'] ?? '') as string,
  };
}

/**
 * Build a media response message to send audio back.
 */
export function buildMediaResponse(streamSid: string, payload: string): string {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: {
      payload,
    },
  });
}

export class MediaWebSocket {
  private _ws: WsType | null = null;
  private _streamSid: string | null = null;
  private _audioQueue: string[] = [];
  private _sendLoopRunning = false;
  private _closed = false;
  private _onAudio: ((audio: Buffer) => void) | null = null;
  private _onStart: ((event: MediaStartEvent) => void) | null = null;
  private _onClose: (() => void) | null = null;
  private _markSeq = 0;
  private _markResolves: Map<string, () => void> = new Map();

  /** Set the handler for inbound audio data. */
  onAudio(handler: (audio: Buffer) => void): void {
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

  /** Connect to a media WebSocket URL. */
  async connect(url: string): Promise<void> {
    const { WebSocket } = await import('ws');

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
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
    if (this._ws && this._streamSid && this._ws.readyState === 1) {
      this._ws.send(
        JSON.stringify({
          event: 'clear',
          streamSid: this._streamSid,
        }),
      );
    }
  }

  /** Send a mark event and return a promise that resolves when the mark is acknowledged. */
  sendMark(): Promise<void> {
    const label = `mark_${++this._markSeq}`;
    return new Promise<void>((resolve) => {
      this._markResolves.set(label, resolve);
      if (this._ws && this._streamSid && this._ws.readyState === 1) {
        this._ws.send(
          JSON.stringify({
            event: 'mark',
            streamSid: this._streamSid,
            mark: { name: label },
          }),
        );
      }
    });
  }

  /** Close the media WebSocket. */
  close(): void {
    this._closed = true;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    // Resolve any pending marks
    for (const resolve of this._markResolves.values()) {
      resolve();
    }
    this._markResolves.clear();
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const event = msg['event'] as string;

    switch (event) {
      case 'start': {
        const startEvt = parseStartEvent(msg);
        this._streamSid = startEvt.streamSid;
        if (this._onStart) {
          this._onStart(startEvt);
        }
        break;
      }
      case 'media': {
        const mediaEvt = parseMediaEvent(msg);
        if (mediaEvt.track === 'inbound' && this._onAudio) {
          const audioBuf = Buffer.from(mediaEvt.chunk, 'base64');
          this._onAudio(audioBuf);
        }
        break;
      }
      case 'mark': {
        const mark = msg['mark'] as Record<string, unknown> | undefined;
        const name = mark?.['name'] as string | undefined;
        if (name && this._markResolves.has(name)) {
          this._markResolves.get(name)!();
          this._markResolves.delete(name);
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
        if (this._streamSid) {
          this._ws.send(buildMediaResponse(this._streamSid, payload));
        }
      }

      setTimeout(loop, 20);
    };

    loop();
  }
}
