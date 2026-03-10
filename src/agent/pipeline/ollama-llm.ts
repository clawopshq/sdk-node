/**
 * Ollama LLM provider for pipeline-based voice agents.
 * Uses the OpenAI-compatible API that Ollama exposes.
 */

import type { ConversationMessage, LLM, LLMChunk } from './base.js';
import type { ToolRegistry } from '../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface OllamaLLMOptions {
  /** Ollama server URL. Default: 'http://localhost:11434' */
  baseUrl?: string;
  /** Model to use. Default: 'llama3.1' */
  model?: string;
  /** Default temperature. */
  temperature?: number;
  /** Default max tokens. */
  maxTokens?: number;
}

export class OllamaLLM implements LLM {
  private _inner: OpenAICompatLLM;

  constructor(options: OllamaLLMOptions = {}) {
    const baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this._inner = new OpenAICompatLLM({
      baseUrl: `${baseUrl}/v1`,
      model: options.model ?? 'llama3.1',
      apiKey: 'ollama',
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
  }

  async *generate(
    messages: ConversationMessage[],
    options?: {
      tools?: ToolRegistry;
      temperature?: number;
      maxTokens?: number;
    },
  ): AsyncGenerator<LLMChunk> {
    yield* this._inner.generate(messages, options);
  }
}
