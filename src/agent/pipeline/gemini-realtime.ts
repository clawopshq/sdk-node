/**
 * Google Gemini Realtime API session (speech-to-speech).
 *
 * Uses @google/genai SDK's live.connect() method.
 * Matches Python SDK's GeminiRealtime implementation (v0.14.0).
 */

import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';
import type { AudioRecorder } from '../recorder.js';
import type { Session } from './base.js';
import type { LiveServerMessage, LiveServerToolCall } from '@google/genai/node';
import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from '../audio.js';

const HANG_UP_TOOL = {
  name: 'hang_up',
  description: 'End the phone call. Use when the conversation is finished or the caller says goodbye.',
  parameters: { type: 'object', properties: {} },
};

/**
 * $ref 문자열을 $defs에서 찾아 반환한다.
 */
function resolveRef(ref: string, defs: Record<string, unknown>): Record<string, unknown> {
  const parts = ref.replace(/^#\//, '').split('/');
  let result: unknown = defs;
  for (const part of parts) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      result = (result as Record<string, unknown>)[part];
    } else {
      return {};
    }
  }
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}

/**
 * JSON Schema를 Gemini functionDeclarations 호환 형식으로 변환한다.
 *
 * - $ref를 인라인으로 resolve
 * - oneOf/anyOf/allOf를 단순화 (첫 번째 object 타입 또는 첫 번째 항목 사용)
 * - 지원되지 않는 키워드 제거
 * - 재귀 깊이 제한으로 순환 참조 방지
 */
function sanitizeSchemaForGemini(
  schema: Record<string, unknown>,
  defs?: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 15) return { type: 'object', properties: {} };
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };

  // 최상위에서 $defs 추출
  if (defs === undefined) {
    defs = (schema['$defs'] ?? schema['definitions'] ?? {}) as Record<string, unknown>;
  }

  // $ref resolve
  if (typeof schema['$ref'] === 'string') {
    const resolved = resolveRef(schema['$ref'], { $defs: defs, definitions: defs });
    if (resolved && Object.keys(resolved).length > 0) {
      return sanitizeSchemaForGemini(resolved, defs, depth + 1);
    }
    return { type: 'object', properties: {} };
  }

  // oneOf / anyOf / allOf 처리
  for (const comboKey of ['oneOf', 'anyOf', 'allOf'] as const) {
    const variants = schema[comboKey];
    if (Array.isArray(variants) && variants.length > 0) {
      // object 타입 우선 선택
      for (const v of variants) {
        if (v && typeof v === 'object') {
          const resolved = sanitizeSchemaForGemini(v as Record<string, unknown>, defs, depth + 1);
          if (resolved['type'] === 'object' && resolved['properties']) {
            return resolved;
          }
        }
      }
      // 없으면 첫 번째 항목
      const first = variants[0];
      if (first && typeof first === 'object') {
        return sanitizeSchemaForGemini(first as Record<string, unknown>, defs, depth + 1);
      }
    }
  }

  const result: Record<string, unknown> = {};

  // type 처리 - 배열 type에서 null 제거
  let schemaType = schema['type'];
  if (Array.isArray(schemaType)) {
    const nonNull = schemaType.filter((t) => t !== 'null');
    schemaType = nonNull[0] ?? 'string';
  }
  if (schemaType) result['type'] = schemaType;

  // description 유지
  if (schema['description']) result['description'] = schema['description'];

  // enum 유지
  if (schema['enum']) result['enum'] = schema['enum'];

  // required 유지
  if (schema['required']) result['required'] = schema['required'];

  // properties 재귀 처리
  if (schema['properties'] && typeof schema['properties'] === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema['properties'] as Record<string, unknown>)) {
      if (val && typeof val === 'object') {
        props[key] = sanitizeSchemaForGemini(val as Record<string, unknown>, defs, depth + 1);
      }
    }
    result['properties'] = props;
  }

  // items 재귀 처리 (array)
  if (schema['items'] && typeof schema['items'] === 'object' && !Array.isArray(schema['items'])) {
    result['items'] = sanitizeSchemaForGemini(schema['items'] as Record<string, unknown>, defs, depth + 1);
  }

  // type이 없고 properties가 있으면 object로 추정
  if (!result['type'] && result['properties']) result['type'] = 'object';

  // type이 object인데 properties가 없으면 빈 properties 추가
  if (result['type'] === 'object' && !result['properties']) result['properties'] = {};

  return result;
}

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
}

export class GeminiRealtime implements Session {
  private _apiKey: string;
  private _systemPrompt: string;
  private _model: string;
  private _voice: string;
  private _language: string;
  private _greeting: boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _session: any = null;
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

    // @google/genai의 conditional exports 타입이 bundler 모드에서
    // live 프로퍼티를 인식하지 못하므로 node 엔트리 직접 import
    const { GoogleGenAI } = await import('@google/genai/node');
    const client = new GoogleGenAI({ apiKey: this._apiKey });

    // Build config (Stage 1 + Stage 2 only)
    const config: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this._voice,
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    if (this._systemPrompt) {
      config['systemInstruction'] = this._systemPrompt;
    }

    // Tools
    const toolSchemas = this._buildToolSchemas();
    if (toolSchemas.length > 0) {
      config['tools'] = [{ functionDeclarations: toolSchemas }];
    }

    this._session = await client.live.connect({
      model: this._model,
      config,
      callbacks: {
        onmessage: (msg) => this._handleMessage(msg),
        onerror: (err) => {
          console.error('[GeminiRealtime] SDK error:', err);
        },
        onclose: () => {
          this._closed = true;
        },
      },
    });

    // Send greeting
    if (this._greeting) {
      this._session.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [{ text: '인사해 주세요.' }],
          },
        ],
        turnComplete: true,
      });
    }
  }

  feedAudio(audio: Buffer): void {
    if (this._session && !this._closed) {
      // G.711 ulaw 8kHz → PCM16 8kHz → PCM16 16kHz
      const pcm8k = ulawToPcm16(audio);
      if (this._recorder) {
        this._recorder.writeInbound(pcm8k);
      }
      const pcm16k = resamplePcm16(pcm8k, 8000, 16000);

      this._session.sendRealtimeInput({
        audio: {
          data: pcm16k,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    }
  }

  async stop(): Promise<void> {
    this._closed = true;
    if (this._session) {
      try {
        this._session.close();
      } catch {
        // Ignore close errors
      }
      this._session = null;
    }
  }

  private _buildToolSchemas(): Array<Record<string, unknown>> {
    const toolDefs: Array<Record<string, unknown>> = this._tools
      ? this._tools.toOpenAITools().map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: sanitizeSchemaForGemini(
            (t.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          ),
        }))
      : [];
    toolDefs.push(HANG_UP_TOOL);
    return toolDefs;
  }

  private _handleMessage(msg: LiveServerMessage): void {
    if (!this._call) return;

    // Handle server content
    const serverContent = msg.serverContent;
    if (serverContent) {
      // Audio from model turn
      const modelTurn = serverContent.modelTurn;
      if (modelTurn) {
        for (const part of modelTurn.parts ?? []) {
          const inlineData = part.inlineData;
          if (inlineData?.data) {
            const mimeType = inlineData.mimeType ?? '';
            if (mimeType.includes('audio')) {
              this._handleAudioData(inlineData.data as string);
            }
          }
          // NOTE: modelTurn text는 outputTranscription과 중복이므로 emit하지 않음
        }
      }

      // Turn complete - flush audio remainder
      if (serverContent.turnComplete) {
        this._flushAudioRemainder();
      }

      // Barge-in (interrupt)
      if (serverContent.interrupted) {
        if (this._call) {
          this._call.clearAudio();
        }
        this._sentAudioChunks = 0;
        this._audioRemainder = Buffer.alloc(0);
      }

      // Input transcription (under serverContent in SDK)
      const inputText = serverContent.inputTranscription?.text;
      if (inputText && this._call) {
        this._call._emit('transcript', 'user', inputText);
      }

      // Output transcription (under serverContent in SDK)
      const outputText = serverContent.outputTranscription?.text;
      if (outputText && this._call) {
        this._call._emit('transcript', 'assistant', outputText);
      }
    }

    // Handle tool calls
    if (msg.toolCall) {
      this._handleToolCall(msg.toolCall);
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

  private async _handleToolCall(toolCall: LiveServerToolCall): Promise<void> {
    const functionCalls = toolCall.functionCalls;
    if (!functionCalls) return;

    const responses: Array<Record<string, unknown>> = [];

    for (const fc of functionCalls) {
      const name = fc.name ?? '';
      const fcId = fc.id ?? '';
      const args = fc.args ?? {};

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

    if (this._session) {
      this._session.sendToolResponse({
        functionResponses: responses,
      });
    }
  }
}
