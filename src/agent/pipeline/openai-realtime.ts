/**
 * OpenAI Realtime API session (speech-to-speech).
 */

import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';
import type { Session } from './base.js';

export interface OpenAIRealtimeOptions {
  /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Default: 'gpt-4o-realtime-preview' */
  model?: string;
  /** Voice ID. Default: 'alloy' */
  voice?: string;
  /** System prompt / instructions. */
  instructions?: string;
  /** Input audio format. Default: 'pcm16' */
  inputAudioFormat?: string;
  /** Output audio format. Default: 'pcm16' */
  outputAudioFormat?: string;
  /** Temperature for generation. */
  temperature?: number;
  /** Turn detection config. Set to null to disable. */
  turnDetection?: Record<string, unknown> | null;
}

export class OpenAIRealtime implements Session {
  private _options: Required<
    Pick<OpenAIRealtimeOptions, 'model' | 'voice' | 'inputAudioFormat' | 'outputAudioFormat'>
  > &
    OpenAIRealtimeOptions;
  private _ws: import('ws').WebSocket | null = null;
  private _callSession: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _closed = false;

  constructor(options: OpenAIRealtimeOptions = {}) {
    this._options = {
      model: 'gpt-4o-realtime-preview',
      voice: 'alloy',
      inputAudioFormat: 'pcm16',
      outputAudioFormat: 'pcm16',
      ...options,
    };
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._callSession = callSession;
    this._tools = tools ?? null;
    this._closed = false;

    const apiKey = this._options.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }

    const { WebSocket } = await import('ws');
    const url = `wss://api.openai.com/v1/realtime?model=${this._options.model}`;

    this._ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    return new Promise<void>((resolve, reject) => {
      const ws = this._ws!;

      ws.on('open', () => {
        this._sendSessionUpdate();
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
        console.error('[OpenAIRealtime] WebSocket error:', err.message);
      });
    });
  }

  feedAudio(audio: Buffer): void {
    if (this._ws && this._ws.readyState === 1 && !this._closed) {
      this._ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: audio.toString('base64'),
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

  private _sendSessionUpdate(): void {
    if (!this._ws || this._ws.readyState !== 1) return;

    const sessionConfig: Record<string, unknown> = {
      modalities: ['text', 'audio'],
      voice: this._options.voice,
      input_audio_format: this._options.inputAudioFormat,
      output_audio_format: this._options.outputAudioFormat,
    };

    if (this._options.instructions) {
      sessionConfig['instructions'] = this._options.instructions;
    }
    if (this._options.temperature !== undefined) {
      sessionConfig['temperature'] = this._options.temperature;
    }
    if (this._options.turnDetection !== undefined) {
      sessionConfig['turn_detection'] = this._options.turnDetection;
    }
    if (this._tools && this._tools.size > 0) {
      sessionConfig['tools'] = this._tools.toOpenAITools().map((t) => t.function);
    }

    this._ws.send(
      JSON.stringify({
        type: 'session.update',
        session: sessionConfig,
      }),
    );
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string;

    switch (type) {
      case 'response.audio.delta': {
        const delta = msg['delta'] as string;
        if (delta && this._callSession) {
          const audio = Buffer.from(delta, 'base64');
          this._callSession.sendAudio(audio);
        }
        break;
      }
      case 'response.audio.done': {
        // Audio stream complete for this response
        break;
      }
      case 'response.function_call_arguments.done': {
        this._handleFunctionCall(msg);
        break;
      }
      case 'input_audio_buffer.speech_started': {
        // User started speaking - clear any outbound audio
        if (this._callSession) {
          this._callSession.clearAudio();
        }
        break;
      }
      case 'error': {
        console.error('[OpenAIRealtime] API error:', msg['error']);
        break;
      }
    }
  }

  private async _handleFunctionCall(msg: Record<string, unknown>): Promise<void> {
    const name = msg['name'] as string;
    const callId = msg['call_id'] as string;
    const argsStr = msg['arguments'] as string;

    if (!this._tools || !this._tools.has(name)) {
      console.error(`[OpenAIRealtime] Unknown tool: ${name}`);
      return;
    }

    try {
      const args = JSON.parse(argsStr) as Record<string, unknown>;
      const result = await this._tools.call(name, args);

      if (this._ws && this._ws.readyState === 1) {
        this._ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: typeof result === 'string' ? result : JSON.stringify(result),
            },
          }),
        );

        // Trigger a new response after tool output
        this._ws.send(JSON.stringify({ type: 'response.create' }));
      }
    } catch (err) {
      console.error(`[OpenAIRealtime] Tool call error for ${name}:`, err);
    }
  }
}
