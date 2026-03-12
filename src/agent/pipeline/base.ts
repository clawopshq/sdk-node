/**
 * Base interfaces for the voice agent pipeline.
 */

import type { CallSession } from '../session.js';
import type { ToolRegistry } from '../tool.js';

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
  /** Start the realtime session with the call session and tools. */
  start(callSession: CallSession, tools?: ToolRegistry): Promise<void>;
  /** Feed raw audio into the session. */
  feedAudio(audio: Buffer): void;
  /** Feed DTMF digits into the LLM context and trigger a response. */
  feedDtmf?(digits: string): Promise<void>;
  /** Stop the session. */
  stop(): Promise<void>;
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
