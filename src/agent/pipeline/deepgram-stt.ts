/**
 * Deepgram STT (Speech-to-Text) provider.
 */

import type { SpeechEvent, STT } from './base.js';

export interface DeepgramSTTOptions {
  /** Deepgram API key. Falls back to DEEPGRAM_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Default: 'nova-2' */
  model?: string;
  /** Language code. Default: 'ko' */
  language?: string;
  /** Enable interim results. Default: true */
  interimResults?: boolean;
  /** Enable punctuation. Default: true */
  punctuate?: boolean;
  /** Enable smart formatting. Default: true */
  smartFormat?: boolean;
  /** Encoding. Default: 'linear16' */
  encoding?: string;
  /** Sample rate. Default: 8000 */
  sampleRate?: number;
  /** Number of channels. Default: 1 */
  channels?: number;
}

export class DeepgramSTT implements STT {
  private _options: DeepgramSTTOptions;

  constructor(options: DeepgramSTTOptions = {}) {
    this._options = {
      model: 'nova-2',
      language: 'ko',
      interimResults: true,
      punctuate: true,
      smartFormat: true,
      encoding: 'linear16',
      sampleRate: 8000,
      channels: 1,
      ...options,
    };
  }

  async *transcribe(
    audioStream: AsyncIterable<Buffer>,
    options?: { language?: string; sampleRate?: number },
  ): AsyncGenerator<SpeechEvent> {
    const apiKey = this._options.apiKey ?? process.env['DEEPGRAM_API_KEY'];
    if (!apiKey) {
      throw new Error('Deepgram API key is required');
    }

    const language = options?.language ?? this._options.language;
    const sampleRate = options?.sampleRate ?? this._options.sampleRate;

    // Use Deepgram live transcription via WebSocket
    const { WebSocket } = await import('ws');

    const params = new URLSearchParams({
      model: this._options.model!,
      language: language!,
      punctuate: String(this._options.punctuate),
      interim_results: String(this._options.interimResults),
      smart_format: String(this._options.smartFormat),
      encoding: this._options.encoding!,
      sample_rate: String(sampleRate),
      channels: String(this._options.channels),
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    // Queue for speech events
    const eventQueue: SpeechEvent[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        const channel = msg['channel'] as Record<string, unknown> | undefined;
        if (!channel) return;

        const alternatives = channel['alternatives'] as Array<Record<string, unknown>> | undefined;
        if (!alternatives || alternatives.length === 0) return;

        const transcript = (alternatives[0]!['transcript'] as string) ?? '';
        if (!transcript) return;

        const isFinal = msg['is_final'] as boolean;
        const speechFinal = msg['speech_final'] as boolean;

        const event: SpeechEvent = {
          type: isFinal || speechFinal ? 'final' : 'interim',
          transcript,
        };

        eventQueue.push(event);
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    });

    ws.on('error', (err: Error) => {
      console.error('[DeepgramSTT] WebSocket error:', err.message);
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Feed audio in background
    const feedPromise = (async () => {
      try {
        for await (const chunk of audioStream) {
          if (done) break;
          if (ws.readyState === 1) {
            ws.send(chunk);
          }
        }
      } finally {
        // Send close message
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      }
    })();

    // Yield speech events
    try {
      while (!done || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else if (!done) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        }
      }
    } finally {
      done = true;
      ws.close();
      await feedPromise.catch(() => {});
    }
  }
}
