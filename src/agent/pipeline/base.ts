/**
 * Base interfaces for the voice agent pipeline.
 */

import type { Logger } from 'pino';

import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';
import type { SessionTelemetry } from '../telemetry.js';

/** Speech recognition event. */
export interface SpeechEvent {
  type: 'interim' | 'final';
  transcript: string;
}

/** Conversation message for LLM context. */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

/** Tool call request from an LLM. */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

/** LLM response chunk (for streaming). */
export interface LLMChunk {
  type: 'text' | 'tool_call' | 'done';
  text?: string;
  toolCall?: ToolCallRequest;
}

/**
 * Session interface for realtime (speech-to-speech) providers.
 * Implementations: OpenAIRealtime, GeminiRealtime
 */
export interface Session {
  /** Start the realtime session with the call session and tools. Thin wrapper over prewarm + attach. */
  start(callSession: CallSession, tools?: ToolRegistry): Promise<void>;
  /**
   * Open LLM connection (and session.update + optional greeting trigger) without a CallSession.
   *
   * Audio deltas produced during the prewarm window accumulate in an internal BufferingCall.
   * attach() then replaces the BufferingCall with the real CallSession and flushes the buffer.
   *
   * Tools may optionally be injected here (alternative to calling setToolRegistry separately);
   * the Session is free to ignore the argument if tools are already set.
   */
  prewarm(tools?: ToolRegistry): Promise<void>;
  /** Attach a real CallSession to a prewarmed session and flush any buffered audio. */
  attach(callSession: CallSession): Promise<void>;
  /** Feed raw audio into the session. */
  feedAudio(audio: Buffer, timestamp?: number): void;
  /** Feed DTMF digits into the LLM context and trigger a response. */
  feedDtmf?(digits: string): Promise<void>;
  /** Stop the session. */
  stop(): Promise<void>;
  /** Set the logger instance for this session. */
  setLogger?(logger: Logger): void;
  /** Return session telemetry for reporting. */
  getTelemetry?(): SessionTelemetry | null;
}

/**
 * Speech-to-Text provider interface.
 */
export interface STT {
  /**
   * Transcribe audio. Returns an async generator of speech events.
   * The generator yields interim results and a final result.
   */
  transcribe(
    audioStream: AsyncIterable<Buffer>,
    options?: { language?: string; sampleRate?: number },
  ): AsyncGenerator<SpeechEvent>;
}

/**
 * LLM (Large Language Model) provider interface.
 */
export interface LLM {
  /**
   * Generate a response from the LLM.
   * Returns an async generator of response chunks.
   */
  generate(
    messages: ConversationMessage[],
    options?: {
      tools?: ToolRegistry;
      temperature?: number;
      maxTokens?: number;
    },
  ): AsyncGenerator<LLMChunk>;
}

/**
 * Text-to-Speech provider interface.
 */
export interface TTS {
  /**
   * Synthesize text to audio.
   * Returns an async generator of PCM16 audio chunks.
   */
  synthesize(
    text: string | AsyncIterable<string>,
    options?: {
      voice?: string;
      sampleRate?: number;
    },
  ): AsyncGenerator<Buffer>;
}
