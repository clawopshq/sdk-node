/**
 * PipelineSession orchestrates STT -> LLM -> TTS for a voice call.
 */

import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';
import type {
  ConversationMessage,
  LLM,
  LLMChunk,
  Session,
  SpeechEvent,
  STT,
  TTS,
} from './base.js';

export interface PipelineSessionOptions {
  stt: STT;
  llm: LLM;
  tts: TTS;
  /** System prompt for the LLM. */
  systemPrompt?: string;
  /** LLM temperature. */
  temperature?: number;
  /** Max tokens for LLM generation. */
  maxTokens?: number;
  /** Sample rate for audio. Default: 8000 */
  sampleRate?: number;
  /** Whether to interrupt TTS when user starts speaking. Default: true */
  interruptOnSpeech?: boolean;
}

export class PipelineSession implements Session {
  private _stt: STT;
  private _llm: LLM;
  private _tts: TTS;
  private _systemPrompt: string | undefined;
  private _temperature: number | undefined;
  private _maxTokens: number | undefined;
  private _sampleRate: number;
  private _interruptOnSpeech: boolean;

  private _callSession: CallSession | null = null;
  private _tools: ToolRegistry | null = null;
  private _conversation: ConversationMessage[] = [];
  private _audioBuffer: Buffer[] = [];
  private _running = false;
  private _speaking = false;

  constructor(options: PipelineSessionOptions) {
    this._stt = options.stt;
    this._llm = options.llm;
    this._tts = options.tts;
    this._systemPrompt = options.systemPrompt;
    this._temperature = options.temperature;
    this._maxTokens = options.maxTokens;
    this._sampleRate = options.sampleRate ?? 8000;
    this._interruptOnSpeech = options.interruptOnSpeech ?? true;
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._callSession = callSession;
    this._tools = tools ?? null;
    this._running = true;
    this._conversation = [];

    if (this._systemPrompt) {
      this._conversation.push({
        role: 'system',
        content: this._systemPrompt,
      });
    }

    // Start the STT listening loop
    this._runSttLoop().catch((err) => {
      console.error('[PipelineSession] STT loop error:', err);
    });
  }

  feedAudio(audio: Buffer): void {
    if (this._running) {
      this._audioBuffer.push(audio);
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    this._audioBuffer = [];
  }

  private async _runSttLoop(): Promise<void> {
    const audioStream = this._createAudioStream();

    for await (const event of this._stt.transcribe(audioStream, {
      sampleRate: this._sampleRate,
    })) {
      if (!this._running) break;

      if (event.type === 'interim' && this._speaking && this._interruptOnSpeech) {
        // User started speaking while TTS is active - interrupt
        this._speaking = false;
        if (this._callSession) {
          this._callSession.clearAudio();
        }
      }

      if (event.type === 'final' && event.transcript.trim()) {
        await this._handleUserSpeech(event.transcript);
      }
    }
  }

  private async *_createAudioStream(): AsyncGenerator<Buffer> {
    while (this._running) {
      if (this._audioBuffer.length > 0) {
        yield this._audioBuffer.shift()!;
      } else {
        // Wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  private async _handleUserSpeech(transcript: string): Promise<void> {
    this._conversation.push({ role: 'user', content: transcript });

    // Run LLM generation (may include tool calls)
    let fullResponse = '';
    const textChunks: string[] = [];

    const llmStream = this._llm.generate(this._conversation, {
      tools: this._tools ?? undefined,
      temperature: this._temperature,
      maxTokens: this._maxTokens,
    });

    for await (const chunk of llmStream) {
      if (!this._running) break;

      if (chunk.type === 'text' && chunk.text) {
        textChunks.push(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        await this._handleToolCall(chunk);
      }
    }

    if (fullResponse.trim()) {
      this._conversation.push({ role: 'assistant', content: fullResponse });
      // Synthesize and send audio
      await this._synthesizeAndSend(fullResponse);
    }
  }

  private async _handleToolCall(chunk: LLMChunk): Promise<void> {
    if (!chunk.toolCall || !this._tools) return;

    const { id, name, arguments: argsStr } = chunk.toolCall;

    try {
      const args = JSON.parse(argsStr) as Record<string, unknown>;
      const result = await this._tools.call(name, args);

      this._conversation.push({
        role: 'assistant',
        content: '',
        // Tool call info stored in the message flow
      });
      this._conversation.push({
        role: 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result),
        tool_call_id: id,
        name,
      });

      // Re-generate after tool result
      let followUpText = '';
      const followUpStream = this._llm.generate(this._conversation, {
        tools: this._tools ?? undefined,
        temperature: this._temperature,
        maxTokens: this._maxTokens,
      });

      for await (const followChunk of followUpStream) {
        if (!this._running) break;
        if (followChunk.type === 'text' && followChunk.text) {
          followUpText += followChunk.text;
        }
      }

      if (followUpText.trim()) {
        this._conversation.push({ role: 'assistant', content: followUpText });
        await this._synthesizeAndSend(followUpText);
      }
    } catch (err) {
      console.error(`[PipelineSession] Tool call error for ${name}:`, err);
    }
  }

  private async _synthesizeAndSend(text: string): Promise<void> {
    if (!this._callSession || !this._running) return;

    this._speaking = true;

    try {
      for await (const audioChunk of this._tts.synthesize(text, {
        sampleRate: this._sampleRate,
      })) {
        if (!this._running || !this._speaking) break;
        this._callSession.sendAudio(audioChunk);
      }
    } catch (err) {
      console.error('[PipelineSession] TTS error:', err);
    } finally {
      this._speaking = false;
    }
  }
}
