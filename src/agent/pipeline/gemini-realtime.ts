/**
 * Google Gemini Realtime API session (speech-to-speech).
 *
 * Matches Python SDK's GeminiRealtime implementation.
 */

import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';
import type { AudioRecorder } from '../recorder.js';
import type { Session } from './base.js';
import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from '../audio.js';

const HANG_UP_TOOL = {
  name: 'hang_up',
  description: 'End the phone call. Use when the conversation is finished or the caller says goodbye.',
  parameters: { type: 'object', properties: {} },
};

export interface GeminiRealtimeOptions {
  /** Google API key. Falls back to GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** System prompt / instructions for the AI. */
  systemPrompt?: string;
  /** Model to use. Default: 'gemini-2.5-flash-native-audio-preview-12-2025' */
  model?: string;
  /** Voice name. Default: 'Kore' */
  voice?: string;
  /** Language code. Default: 'ko' */
  language?: string;
  /** Send initial greeting. Default: true */
  greeting?: boolean;
  /** Generation config overrides. */
  generationConfig?: Record<string, unknown>;
}

export class GeminiRealtime implements Session {
  private _apiKey: string;
  private _systemPrompt: string;
  private _model: string;
  private _voice: string;
  private _language: string;
  private _greeting: boolean;
  private _generationConfig: Record<string, unknown> | undefined;

  private _ws: import('ws').WebSocket | null = null;
  private _call: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _recorder: AudioRecorder | null = null;
  private _closed = false;
  private _sentAudioChunks = 0;
  private _audioRemainder: Buffer = Buffer.alloc(0);

  constructor(options: GeminiRealtimeOptions = {}) {
    this._apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'] ?? '';
    this._systemPrompt = options.systemPrompt ?? '';
    this._model = options.model ?? 'gemini-2.5-flash-native-audio-preview-12-2025';
    this._voice = options.voice ?? 'Kore';
    this._language = options.language ?? 'ko';
    this._greeting = options.greeting ?? true;
    this._generationConfig = options.generationConfig;
  }

  /** Inject per-call ToolRegistry. */
  setToolRegistry(registry: ToolRegistry): void {
    this._tools = registry;
  }

  /** Inject per-call AudioRecorder. */
  setRecorder(recorder: AudioRecorder): void {
    this._recorder = recorder;
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._call = callSession;
    if (tools) this._tools = tools;
    this._closed = false;
    this._sentAudioChunks = 0;
    this._audioRemainder = Buffer.alloc(0);

    if (!this._apiKey) {
      throw new Error('Google API key is required. Set GOOGLE_API_KEY or pass apiKey option.');
    }

    const { WebSocket } = await import('ws');
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this._apiKey}`;

    this._ws = new WebSocket(url);

    return new Promise<void>((resolve, reject) => {
      const ws = this._ws!;

      ws.on('open', () => {
        this._sendSetup();
        // Wait for setupComplete before resolving
        this._waitSetupComplete().then(() => {
          if (this._greeting) {
            this._sendGreeting();
          }
          // Start receive loop
          this._receiveLoop();
          resolve();
        }).catch(reject);
      });

      ws.on('close', () => {
        this._closed = true;
      });

      ws.on('error', (err: Error) => {
        if (!this._ws) {
          reject(err);
        }
        console.error('[GeminiRealtime] WebSocket error:', err.message);
      });
    });
  }

  feedAudio(audio: Buffer): void {
    if (this._ws && this._ws.readyState === 1 && !this._closed) {
      // G.711 ulaw 8kHz → PCM16 8kHz → PCM16 16kHz
      const pcm8k = ulawToPcm16(audio);
      const pcm16k = resamplePcm16(pcm8k, 8000, 16000);

      this._ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: 'audio/pcm;rate=16000',
                data: pcm16k.toString('base64'),
              },
            ],
          },
        }),
      );
    }
  }

  async stop(): Promise<void> {
    this._closed = true;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  private _sendSetup(): void {
    if (!this._ws || this._ws.readyState !== 1) return;

    const setupConfig: Record<string, unknown> = {
      model: `models/${this._model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this._voice,
            },
          },
        },
        ...this._generationConfig,
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
        },
      },
    };

    if (this._systemPrompt) {
      setupConfig['systemInstruction'] = {
        parts: [{ text: this._systemPrompt }],
      };
    }

    // Tools: user tools + hang_up
    const toolDefs: Array<Record<string, unknown>> = this._tools
      ? this._tools.toOpenAITools().map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        }))
      : [];
    toolDefs.push(HANG_UP_TOOL);
    setupConfig['tools'] = [{ functionDeclarations: toolDefs }];

    this._ws.send(JSON.stringify({ setup: setupConfig }));
  }

  private _waitSetupComplete(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const onMessage = (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if ('setupComplete' in msg) {
            this._ws?.removeListener('message', onMessage);
            resolve();
          }
        } catch {
          // Ignore parse errors
        }
      };
      this._ws.on('message', onMessage);
    });
  }

  private _sendGreeting(): void {
    if (!this._ws || this._ws.readyState !== 1) return;
    this._ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: '인사해 주세요.' }],
            },
          ],
          turnComplete: true,
        },
      }),
    );
  }

  private _receiveLoop(): void {
    if (!this._ws) return;
    this._ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this._handleMessage(msg);
      } catch {
        // Ignore parse errors
      }
    });
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    if (!this._call) return;

    // Handle server content with audio
    const serverContent = msg['serverContent'] as Record<string, unknown> | undefined;
    if (serverContent) {
      const modelTurn = serverContent['modelTurn'] as Record<string, unknown> | undefined;
      if (modelTurn) {
        const parts = modelTurn['parts'] as Array<Record<string, unknown>> | undefined;
        if (parts) {
          for (const part of parts) {
            const inlineData = part['inlineData'] as Record<string, unknown> | undefined;
            if (inlineData && inlineData['data']) {
              const mimeType = (inlineData['mimeType'] as string) ?? '';
              if (mimeType.includes('audio')) {
                this._handleAudioData(inlineData['data'] as string);
              }
            }

            // Text transcript from model turn
            const text = part['text'] as string | undefined;
            if (text && this._call) {
              this._call._emit('transcript', 'assistant', text);
            }
          }
        }
      }

      // Turn complete - flush audio remainder
      if (serverContent['turnComplete']) {
        this._flushAudioRemainder();
      }

      // Barge-in (interrupt)
      if (serverContent['interrupted']) {
        if (this._call) {
          this._call.clearAudio();
        }
        this._sentAudioChunks = 0;
        this._audioRemainder = Buffer.alloc(0);
      }
    }

    // Input transcription (top-level field)
    const inputTranscription = msg['inputTranscription'] as Record<string, unknown> | undefined;
    if (inputTranscription) {
      const text = inputTranscription['text'] as string | undefined;
      if (text && this._call) {
        this._call._emit('transcript', 'user', text);
      }
    }

    // Output transcription (top-level field)
    const outputTranscription = msg['outputTranscription'] as Record<string, unknown> | undefined;
    if (outputTranscription) {
      const text = outputTranscription['text'] as string | undefined;
      if (text && this._call) {
        this._call._emit('transcript', 'assistant', text);
      }
    }

    // Handle tool calls
    const toolCall = msg['toolCall'] as Record<string, unknown> | undefined;
    if (toolCall) {
      this._handleToolCall(toolCall);
    }

    // Handle tool call cancellation
    if (msg['toolCallCancellation']) {
      // Logged but no action needed
    }
  }

  private _handleAudioData(b64Data: string): void {
    if (!this._call) return;

    const pcm24k = Buffer.from(b64Data, 'base64');
    if (this._recorder) {
      this._recorder.writeOutbound(resamplePcm16(pcm24k, 24000, 8000));
    }

    // PCM16 24kHz → PCM16 8kHz → G.711 ulaw
    const pcm8k = resamplePcm16(pcm24k, 24000, 8000);
    const ulaw = pcm16ToUlaw(pcm8k);

    // 160B frame alignment (160B = 20ms at 8kHz ulaw)
    const combined = Buffer.concat([this._audioRemainder, ulaw]);
    const chunkSize = 160;
    const fullEnd = Math.floor(combined.length / chunkSize) * chunkSize;
    for (let off = 0; off < fullEnd; off += chunkSize) {
      this._call.sendAudio(combined.subarray(off, off + chunkSize));
      this._sentAudioChunks++;
    }
    this._audioRemainder = combined.subarray(fullEnd);
  }

  private _flushAudioRemainder(): void {
    if (this._audioRemainder.length > 0 && this._call) {
      const padded = Buffer.concat([
        this._audioRemainder,
        Buffer.alloc(160 - this._audioRemainder.length, 0xff),
      ]);
      this._call.sendAudio(padded);
      this._sentAudioChunks++;
      this._audioRemainder = Buffer.alloc(0);
    }
  }

  private async _handleToolCall(toolCall: Record<string, unknown>): Promise<void> {
    const functionCalls = toolCall['functionCalls'] as Array<Record<string, unknown>> | undefined;
    if (!functionCalls) return;

    const responses: Array<Record<string, unknown>> = [];

    for (const fc of functionCalls) {
      const name = fc['name'] as string;
      const fcId = (fc['id'] as string) ?? '';
      const args = (fc['args'] as Record<string, unknown>) ?? {};

      // Built-in hang_up tool
      if (name === 'hang_up') {
        if (this._call) {
          this._call.hangup();
        }
        return;
      }

      if (!this._tools || !this._tools.has(name)) {
        console.error(`[GeminiRealtime] Unknown tool: ${name}`);
        responses.push({ id: fcId, name, response: { error: `Unknown tool: ${name}` } });
        continue;
      }

      try {
        const result = await this._tools.call(name, args);
        responses.push({
          id: fcId,
          name,
          response: { result: typeof result === 'string' ? result : JSON.stringify(result) },
        });
      } catch (err) {
        console.error(`[GeminiRealtime] Tool call error for ${name}:`, err);
        responses.push({
          id: fcId,
          name,
          response: { error: String(err) },
        });
      }
    }

    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: responses,
          },
        }),
      );
    }
  }
}
