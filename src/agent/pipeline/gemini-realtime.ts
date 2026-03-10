/**
 * Google Gemini Realtime API session (speech-to-speech).
 */

import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';
import type { Session } from './base.js';

export interface GeminiRealtimeOptions {
  /** Google API key. Falls back to GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Default: 'gemini-2.0-flash-exp' */
  model?: string;
  /** Voice name. */
  voice?: string;
  /** System instruction. */
  systemInstruction?: string;
  /** Generation config overrides. */
  generationConfig?: Record<string, unknown>;
}

export class GeminiRealtime implements Session {
  private _options: Required<Pick<GeminiRealtimeOptions, 'model'>> & GeminiRealtimeOptions;
  private _ws: import('ws').WebSocket | null = null;
  private _callSession: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _closed = false;

  constructor(options: GeminiRealtimeOptions = {}) {
    this._options = {
      model: 'gemini-2.0-flash-exp',
      ...options,
    };
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._callSession = callSession;
    this._tools = tools ?? null;
    this._closed = false;

    const apiKey = this._options.apiKey ?? process.env['GOOGLE_API_KEY'];
    if (!apiKey) {
      throw new Error('Google API key is required');
    }

    const { WebSocket } = await import('ws');
    const model = this._options.model;
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    this._ws = new WebSocket(url);

    return new Promise<void>((resolve, reject) => {
      const ws = this._ws!;

      ws.on('open', () => {
        this._sendSetup();
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
      this._ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: 'audio/pcm;rate=16000',
                data: audio.toString('base64'),
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
      model: `models/${this._options.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this._options.voice ?? 'Aoede',
            },
          },
        },
        ...this._options.generationConfig,
      },
    };

    if (this._options.systemInstruction) {
      setupConfig['systemInstruction'] = {
        parts: [{ text: this._options.systemInstruction }],
      };
    }

    if (this._tools && this._tools.size > 0) {
      const toolDefs = this._tools.toOpenAITools().map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
      setupConfig['tools'] = [{ functionDeclarations: toolDefs }];
    }

    this._ws.send(JSON.stringify({ setup: setupConfig }));
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    // Handle server content with audio
    const serverContent = msg['serverContent'] as Record<string, unknown> | undefined;
    if (serverContent) {
      const modelTurn = serverContent['modelTurn'] as Record<string, unknown> | undefined;
      if (modelTurn) {
        const parts = modelTurn['parts'] as Array<Record<string, unknown>> | undefined;
        if (parts) {
          for (const part of parts) {
            const inlineData = part['inlineData'] as Record<string, unknown> | undefined;
            if (inlineData && inlineData['data'] && this._callSession) {
              const audio = Buffer.from(inlineData['data'] as string, 'base64');
              this._callSession.sendAudio(audio);
            }
          }
        }
      }
    }

    // Handle tool calls
    const toolCall = msg['toolCall'] as Record<string, unknown> | undefined;
    if (toolCall) {
      this._handleToolCall(toolCall);
    }
  }

  private async _handleToolCall(toolCall: Record<string, unknown>): Promise<void> {
    const functionCalls = toolCall['functionCalls'] as Array<Record<string, unknown>> | undefined;
    if (!functionCalls || !this._tools) return;

    const responses: Array<Record<string, unknown>> = [];

    for (const fc of functionCalls) {
      const name = fc['name'] as string;
      const args = (fc['args'] as Record<string, unknown>) ?? {};

      try {
        const result = await this._tools.call(name, args);
        responses.push({
          name,
          response: { result: typeof result === 'string' ? result : JSON.stringify(result) },
        });
      } catch (err) {
        console.error(`[GeminiRealtime] Tool call error for ${name}:`, err);
        responses.push({
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
