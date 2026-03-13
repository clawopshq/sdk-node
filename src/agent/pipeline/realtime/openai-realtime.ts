/**
 * OpenAI Realtime API session (speech-to-speech).
 *
 * Matches Python SDK's OpenAIRealtime implementation.
 */

import type { CallSession } from '../../session.js';
import type { ToolRegistry } from '../../tool.js';
import type { AudioRecorder } from '../../recorder.js';
import type { Session } from '../base.js';
import { ulawToPcm16 } from '../../audio.js';
import { BuiltinTool } from '../../builtin-tool.js';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../../logger.js';
import { BUILTIN_TOOL_NAMES, executeBuiltinTool, getBuiltinToolSchemas } from '../builtin-tool-schemas.js';

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=';

export interface OpenAIRealtimeOptions {
  /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** System prompt / instructions for the AI. */
  systemPrompt?: string;
  /** Model to use. Default: 'gpt-realtime-1.5' */
  model?: string;
  /** Voice ID. Default: 'marin' */
  voice?: string;
  /** Language code (BCP 47). Default: 'ko' */
  language?: string;
  /** VAD eagerness: 'low', 'medium', 'high'. Default: 'high' */
  eagerness?: string;
  /** Send initial greeting. Default: true */
  greeting?: boolean;
}

export class OpenAIRealtime implements Session {
  private _apiKey: string;
  private _systemPrompt: string;
  private _model: string;
  private _voice: string;
  private _language: string;
  private _eagerness: string;
  private _greeting: boolean;

  private _log: Logger = NOOP_LOGGER;
  private _builtinTools: Set<BuiltinTool> | null = null;

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  setBuiltinTools(tools: Set<BuiltinTool>): void {
    this._builtinTools = tools;
  }

  private _ws: import('ws').WebSocket | null = null;
  private _call: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _recorder: AudioRecorder | null = null;
  private _closed = false;

  // Truncation / barge-in tracking (matching Python SDK)
  private _lastAssistantItem: string | null = null;
  private _responseStartTs: number | null = null;
  private _sentAudioChunks = 0;
  private _audioRemainder: Buffer = Buffer.alloc(0);

  // Response state tracking — prevent sending response.create while one is active
  private _responseInProgress = false;
  private _onResponseDone: (() => void) | null = null;

  constructor(options: OpenAIRealtimeOptions = {}) {
    this._apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this._systemPrompt = options.systemPrompt ?? '';
    this._model = options.model ?? 'gpt-realtime-1.5';
    this._voice = options.voice ?? 'marin';
    this._language = options.language ?? 'ko';
    this._eagerness = options.eagerness ?? 'high';
    this._greeting = options.greeting ?? true;
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
    this._lastAssistantItem = null;
    this._responseStartTs = null;
    this._sentAudioChunks = 0;
    this._audioRemainder = Buffer.alloc(0);

    if (!this._apiKey) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey option.');
    }

    const { WebSocket } = await import('ws');
    const url = `${OPENAI_REALTIME_URL}${this._model}`;

    this._ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    return new Promise<void>((resolve, reject) => {
      const ws = this._ws!;

      ws.on('open', () => {
        this._sendSessionUpdate();
        this._log.info('OpenAI Realtime connected');

        // Send initial greeting if enabled (matching Python SDK)
        if (this._greeting) {
          this._send({ type: 'response.create' });
        }

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
        this._log.error({ err }, 'OpenAI Realtime WS error');
      });
    });
  }

  async feedDtmf(digits: string): Promise<void> {
    await this._waitForResponseDone();
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[DTMF 입력: ${digits}]` }],
      },
    });
    this._send({ type: 'response.create' });
  }

  feedAudio(audio: Buffer): void {
    if (this._ws && this._ws.readyState === 1 && !this._closed) {
      // Agent path: audio comes as ulaw directly from platform, no conversion needed
      this._send({
        type: 'input_audio_buffer.append',
        audio: audio.toString('base64'),
      });
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

    // Build tool schemas: user tools + builtin tools
    // OpenAI Realtime API uses flat tool format: { type, name, description, parameters }
    const toolSchemas: Array<Record<string, unknown>> = this._tools
      ? this._tools.toOpenAITools().map((t) => ({ type: 'function' as const, ...t.function }))
      : [];
    toolSchemas.push(...getBuiltinToolSchemas(this._builtinTools, 'realtime'));

    this._send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: this._voice,
        instructions: this._systemPrompt,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1',
          language: this._language,
        },
        input_audio_noise_reduction: { type: 'far_field' },
        turn_detection: {
          type: 'semantic_vad',
          interrupt_response: true,
          eagerness: this._eagerness,
        },
        tools: toolSchemas,
      },
    });
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string;

    switch (type) {
      case 'response.audio.delta': {
        this._handleAudioDelta(msg);
        break;
      }
      case 'response.audio.done': {
        // Flush remaining audio with silence padding
        if (this._audioRemainder.length > 0) {
          const padded = Buffer.concat([
            this._audioRemainder,
            Buffer.alloc(160 - this._audioRemainder.length, 0xff),
          ]);
          if (this._call) {
            this._call.sendAudio(padded);
          }
          this._sentAudioChunks++;
          this._audioRemainder = Buffer.alloc(0);
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
        this._handleTruncation();
        break;
      }
      case 'response.output_item.done': {
        // Handle tool calls (matching Python SDK: response.output_item.done)
        const item = msg['item'] as Record<string, unknown> | undefined;
        if (item && item['type'] === 'function_call') {
          this._handleToolCall(item);
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        // User transcript
        if (this._call) {
          this._call._emit('transcript', 'user', (msg['transcript'] as string) ?? '');
        }
        break;
      }
      case 'response.audio_transcript.done': {
        // Assistant transcript
        if (this._call) {
          this._call._emit('transcript', 'assistant', (msg['transcript'] as string) ?? '');
        }
        break;
      }
      case 'response.created': {
        this._responseInProgress = true;
        break;
      }
      case 'response.done': {
        this._responseInProgress = false;
        if (this._onResponseDone) {
          const cb = this._onResponseDone;
          this._onResponseDone = null;
          cb();
        }
        break;
      }
      case 'error': {
        this._log.error({ apiError: msg['error'] }, 'OpenAI error');
        break;
      }
    }
  }

  private _handleAudioDelta(msg: Record<string, unknown>): void {
    if (this._responseStartTs === null) {
      this._responseStartTs = Date.now();
      this._sentAudioChunks = 0;
    }
    if (msg['item_id']) {
      this._lastAssistantItem = msg['item_id'] as string;
    }

    const ulaw = Buffer.from(msg['delta'] as string, 'base64');

    if (this._recorder) {
      this._recorder.writeOutbound(ulawToPcm16(ulaw));
    }

    // Align to 160B (20ms at 8kHz ulaw) frames, matching Python SDK
    const combined = Buffer.concat([this._audioRemainder, ulaw]);
    const chunkSize = 160;
    const fullEnd = Math.floor(combined.length / chunkSize) * chunkSize;

    for (let off = 0; off < fullEnd; off += chunkSize) {
      if (this._call) {
        this._call.sendAudio(combined.subarray(off, off + chunkSize));
      }
      this._sentAudioChunks++;
    }

    this._audioRemainder = combined.subarray(fullEnd);
  }

  private _handleTruncation(): void {
    if (!this._lastAssistantItem || this._responseStartTs === null) {
      return;
    }

    // Calculate audio end based on sent chunks (160B = 20ms per ulaw chunk)
    const audioEndMs = Math.max(0, this._sentAudioChunks * 20);

    this._send({
      type: 'conversation.item.truncate',
      item_id: this._lastAssistantItem,
      content_index: 0,
      audio_end_ms: audioEndMs,
    });

    if (this._call) {
      this._call.clearAudio();
    }

    this._lastAssistantItem = null;
    this._responseStartTs = null;
    this._sentAudioChunks = 0;
    this._audioRemainder = Buffer.alloc(0);
  }

  private async _handleToolCall(item: Record<string, unknown>): Promise<void> {
    const funcName = item['name'] as string;
    const callId = item['call_id'] as string;
    this._log.info('Tool call: %s', funcName);

    // Built-in tools
    if (BUILTIN_TOOL_NAMES.has(funcName) && this._call) {
      const args = JSON.parse((item['arguments'] as string) ?? '{}') as Record<string, unknown>;
      const result = await executeBuiltinTool(funcName, args, this._call);
      if (result !== null) {
        if (funcName === 'hang_up') return;
        await this._waitForResponseDone();
        this._send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: result,
          },
        });
        this._send({ type: 'response.create' });
        return;
      }
    }

    if (!this._tools || !this._tools.has(funcName)) {
      this._log.error('Unknown tool: %s', funcName);
      return;
    }

    let result: unknown;
    try {
      const args = JSON.parse((item['arguments'] as string) ?? '{}') as Record<string, unknown>;
      result = await this._tools.call(funcName, args);
    } catch (err) {
      this._log.error({ err }, 'Tool call failed: %s', funcName);
      result = `Error: ${err}`;
    }

    await this._waitForResponseDone();
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof result === 'string' ? result : JSON.stringify(result),
      },
    });

    this._send({ type: 'response.create' });
  }

  private _waitForResponseDone(): Promise<void> {
    if (!this._responseInProgress) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this._onResponseDone = resolve;
    });
  }

  private _send(data: Record<string, unknown>): void {
    if (this._ws && this._ws.readyState === 1 && !this._closed) {
      this._ws.send(JSON.stringify(data));
    }
  }
}
