/**
 * OpenAI Realtime API session (speech-to-speech).
 *
 * Matches Python SDK's OpenAIRealtime implementation.
 */

import type { CallSession } from '../../session.js';
import type { ToolRegistry } from '../../tool.js';
import type { AudioRecorder } from '../../recorder.js';
import type { Session } from '../base.js';
import type { SessionTelemetry } from '../../telemetry.js';
import { BuiltinTool } from '../../builtin-tool.js';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../../logger.js';
import { HoldAudioPlayer } from '../../hold-audio.js';
import {
  BUILTIN_TOOL_NAMES,
  executeBuiltinTool,
  getBuiltinToolSchemas,
} from '../builtin-tool-schemas.js';

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=';

/**
 * 현재 재생 중인 응답의 상태. 하나의 assistant 응답에 대한 모든 정보를 담는다.
 */
interface PlaybackState {
  itemId: string; // OpenAI conversation item ID
  startTs: number; // 첫 delta 수신 시점의 media timestamp
  sentChunks: number; // 플랫폼으로 전송된 오디오 청크 수 (각 20ms)
  generating: boolean; // OpenAI가 아직 오디오를 생성 중인지
  audioRemainder: Buffer; // 160B 미만 잔여 오디오 버퍼
}

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
  /**
   * Turn detection configuration. Default: semantic_vad with eagerness 'medium'.
   * - `{ type: 'semantic_vad', eagerness?: 'low'|'medium'|'high'|'auto', interrupt_response?: boolean }`
   * - `{ type: 'server_vad', threshold?: number, silence_duration_ms?: number, prefix_padding_ms?: number }`
   * - `null` to disable turn detection
   */
  turnDetection?: Record<string, unknown> | null;
  /** Send initial greeting. Default: true */
  greeting?: boolean;
}

export class OpenAIRealtime implements Session {
  private _apiKey: string;
  private _systemPrompt: string;
  private _model: string;
  private _voice: string;
  private _language: string;
  private _turnDetection!: Record<string, unknown> | null;
  private _greeting: boolean;

  private _log: Logger = NOOP_LOGGER;
  private _builtinTools: Set<BuiltinTool> | null = null;

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  setBuiltinTools(tools: Set<BuiltinTool>): void {
    this._builtinTools = tools;
  }

  getTelemetry(): SessionTelemetry {
    return {
      sessionType: 'openai_realtime',
      llm: { provider: 'openai', model: this._model },
      stt: null,
      tts: null,
      voice: this._voice,
      language: this._language,
      greetingEnabled: this._greeting,
      recordingEnabled: !!this._recorder,
      toolCount: this._tools?.size ?? 0,
      mcpServerCount: 0,
      builtinTools: [],
    };
  }

  private _ws: import('ws').WebSocket | null = null;
  private _call: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _recorder: AudioRecorder | null = null;
  private _closed = false;

  // PlaybackState — 현재 재생 중인 응답 상태
  private _playback: PlaybackState | null = null;
  private _latestMediaTs = 0;

  // Pending tool call tracking — 인터럽트 시 취소용
  private _pendingToolCalls = new Map<string, AbortController>();

  // Response state tracking — prevent sending response.create while one is active
  private _responseInProgress = false;
  private _onResponseDone: (() => void) | null = null;

  // Hold audio — tool 실행 중 대기음
  private _holdAudioChunks: Buffer[] | null = null;

  constructor(options: OpenAIRealtimeOptions = {}) {
    this._apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this._systemPrompt = options.systemPrompt ?? '';
    this._model = options.model ?? 'gpt-realtime-1.5';
    this._voice = options.voice ?? 'marin';
    this._language = options.language ?? 'ko';
    this._turnDetection =
      options.turnDetection !== undefined
        ? options.turnDetection
        : { type: 'semantic_vad', eagerness: 'medium', interrupt_response: true };
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

  /** Tool 실행 중 재생할 hold audio 청크를 설정한다. */
  setHoldAudio(chunks: Buffer[]): void {
    this._holdAudioChunks = chunks;
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._call = callSession;
    if (tools) this._tools = tools;
    this._closed = false;
    this._playback = null;
    this._latestMediaTs = 0;

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

  feedAudio(audio: Buffer, timestamp?: number): void {
    this._latestMediaTs = timestamp ?? this._latestMediaTs;
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
    // Pending tool call 정리
    for (const [, controller] of this._pendingToolCalls) {
      controller.abort();
    }
    this._pendingToolCalls.clear();
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
        turn_detection: this._turnDetection,
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
        if (this._playback) {
          this._playback.generating = false;
          if (this._playback.audioRemainder.length > 0) {
            const padded = Buffer.concat([
              this._playback.audioRemainder,
              Buffer.alloc(160 - this._playback.audioRemainder.length, 0xff),
            ]);
            if (this._call) {
              this._call.sendAudio(padded);
            }
            this._playback.sentChunks++;
            this._playback.audioRemainder = Buffer.alloc(0);
          }
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
        this._handleTruncation();
        break;
      }
      case 'response.output_item.done': {
        // Handle tool calls — fire-and-forget (matching Python SDK)
        const item = msg['item'] as Record<string, unknown> | undefined;
        if (item && item['type'] === 'function_call') {
          this._handleToolCall(item);
          // _playback은 여기서 리셋하지 않는다.
          // 큐에 재생 대기 중인 오디오가 있을 수 있고,
          // 인터럽트 시 truncate하려면 item_id가 필요하다.
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
    if (this._playback === null) {
      this._playback = {
        itemId: (msg['item_id'] as string) || '',
        startTs: this._latestMediaTs,
        sentChunks: 0,
        generating: true,
        audioRemainder: Buffer.alloc(0),
      };
    } else if (msg['item_id']) {
      this._playback.itemId = msg['item_id'] as string;
    }

    const pb = this._playback;
    const ulaw = Buffer.from(msg['delta'] as string, 'base64');

    // Align to 160B (20ms at 8kHz ulaw) frames, matching Python SDK
    const combined = Buffer.concat([pb.audioRemainder, ulaw]);
    const chunkSize = 160;
    const fullEnd = Math.floor(combined.length / chunkSize) * chunkSize;

    for (let off = 0; off < fullEnd; off += chunkSize) {
      if (this._call) {
        this._call.sendAudio(combined.subarray(off, off + chunkSize));
      }
      pb.sentChunks++;
    }

    pb.audioRemainder = combined.subarray(fullEnd);
  }

  private _handleTruncation(): void {
    // 진행 중인 tool call 취소
    for (const [, controller] of this._pendingToolCalls) {
      controller.abort();
    }
    this._pendingToolCalls.clear();

    // 큐에 남아있는 오디오를 항상 비운다
    if (this._call) {
      this._call.clearAudio();
    }

    const pb = this._playback;
    if (pb === null) {
      return;
    }

    // interrupt_response=true이므로 서버가 자동으로 응답을 취소한다.
    // response.cancel을 중복 호출하면 서버 상태가 꼬일 수 있으므로 생략.
    // conversation.item.truncate는 오디오와 transcript를 모두 잘라내어
    // 대화 맥락을 손실시키므로 호출하지 않는다.
    const playedMs = Math.max(0, this._latestMediaTs - pb.startTs);

    this._log.info(
      '[Interrupt] item=%s played=%dms total=%dms',
      pb.itemId,
      playedMs,
      pb.sentChunks * 20,
    );

    this._playback = null;
  }

  private async _handleToolCall(item: Record<string, unknown>): Promise<void> {
    const funcName = item['name'] as string;
    const callId = item['call_id'] as string;
    this._log.info('Tool call: %s', funcName);

    const controller = new AbortController();
    this._pendingToolCalls.set(callId, controller);

    try {
      // Built-in tools
      if (BUILTIN_TOOL_NAMES.has(funcName) && this._call) {
        const args = JSON.parse((item['arguments'] as string) ?? '{}') as Record<string, unknown>;
        const result = await executeBuiltinTool(funcName, args, this._call);
        if (result !== null) {
          if (funcName === 'hang_up') return;
          if (controller.signal.aborted) return;
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
        await this._waitForResponseDone();
        this._send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ error: `Unknown tool: ${funcName}` }),
          },
        });
        this._send({ type: 'response.create' });
        return;
      }

      let result: unknown;
      const player =
        this._holdAudioChunks && this._call
          ? new HoldAudioPlayer(this._call, this._holdAudioChunks)
          : null;
      player?.start();
      try {
        const args = JSON.parse((item['arguments'] as string) ?? '{}') as Record<string, unknown>;
        this._call?.recordToolCall();
        result = await this._tools.call(funcName, args);
      } catch (err) {
        this._log.error({ err }, 'Tool call failed: %s', funcName);
        if (err instanceof Error) {
          this._call?.recordToolError(err);
        }
        result = `Error: ${err}`;
      } finally {
        player?.stop();
      }

      if (controller.signal.aborted) {
        this._log.info('Tool call cancelled (user interrupted): %s', funcName);
        return;
      }

      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      await this._waitForResponseDone();
      this._send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: resultStr,
        },
      });
      this._log.info('[ToolResult] %s call_id=%s len=%d', funcName, callId, resultStr.length);
      this._send({ type: 'response.create' });
    } finally {
      this._pendingToolCalls.delete(callId);
    }
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
