/**
 * ElevenLabs TTS (Text-to-Speech) provider.
 */

import type { TTS } from './base.js';

export interface ElevenLabsTTSOptions {
  /** ElevenLabs API key. Falls back to ELEVENLABS_API_KEY env var. */
  apiKey?: string;
  /** Voice ID. Default: '21m00Tcm4TlvDq8ikWAM' (Rachel) */
  voiceId?: string;
  /** Model ID. Default: 'eleven_multilingual_v2' */
  modelId?: string;
  /** Output format. Default: 'pcm_16000' */
  outputFormat?: string;
  /** Stability. Default: 0.5 */
  stability?: number;
  /** Similarity boost. Default: 0.75 */
  similarityBoost?: number;
  /** Style. Default: 0 */
  style?: number;
  /** Use speaker boost. Default: true */
  useSpeakerBoost?: boolean;
}

export class ElevenLabsTTS implements TTS {
  private _options: ElevenLabsTTSOptions;

  constructor(options: ElevenLabsTTSOptions = {}) {
    this._options = {
      voiceId: '21m00Tcm4TlvDq8ikWAM',
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'pcm_16000',
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0,
      useSpeakerBoost: true,
      ...options,
    };
  }

  async *synthesize(
    text: string | AsyncIterable<string>,
    options?: { voice?: string; sampleRate?: number },
  ): AsyncGenerator<Buffer> {
    const apiKey = this._options.apiKey ?? process.env['ELEVENLABS_API_KEY'];
    if (!apiKey) {
      throw new Error('ElevenLabs API key is required');
    }

    const voiceId = options?.voice ?? this._options.voiceId;

    if (typeof text === 'string') {
      // Non-streaming: single request
      yield* this._synthesizeSingle(apiKey, voiceId!, text);
    } else {
      // Streaming: use WebSocket for chunked text input
      yield* this._synthesizeStreaming(apiKey, voiceId!, text);
    }
  }

  private async *_synthesizeSingle(
    apiKey: string,
    voiceId: string,
    text: string,
  ): AsyncGenerator<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${this._options.outputFormat}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: this._options.modelId,
        voice_settings: {
          stability: this._options.stability,
          similarity_boost: this._options.similarityBoost,
          style: this._options.style,
          use_speaker_boost: this._options.useSpeakerBoost,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const body = response.body;
    if (!body) {
      throw new Error('ElevenLabs returned empty response');
    }

    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield Buffer.from(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async *_synthesizeStreaming(
    apiKey: string,
    voiceId: string,
    textStream: AsyncIterable<string>,
  ): AsyncGenerator<Buffer> {
    const { WebSocket } = await import('ws');

    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${this._options.modelId}&output_format=${this._options.outputFormat}`;

    const ws = new WebSocket(url);

    const audioQueue: Buffer[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    ws.on('open', () => {
      // Send initial config
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: this._options.stability,
            similarity_boost: this._options.similarityBoost,
            style: this._options.style,
            use_speaker_boost: this._options.useSpeakerBoost,
          },
          xi_api_key: apiKey,
        }),
      );
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        const audio = msg['audio'] as string | undefined;
        if (audio) {
          audioQueue.push(Buffer.from(audio, 'base64'));
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
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
      console.error('[ElevenLabsTTS] WebSocket error:', err.message);
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

    // Feed text in background
    const feedPromise = (async () => {
      try {
        for await (const chunk of textStream) {
          if (done) break;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ text: chunk }));
          }
        }
      } finally {
        // Send end-of-stream
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ text: '' }));
        }
      }
    })();

    // Yield audio chunks
    try {
      while (!done || audioQueue.length > 0) {
        if (audioQueue.length > 0) {
          yield audioQueue.shift()!;
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
