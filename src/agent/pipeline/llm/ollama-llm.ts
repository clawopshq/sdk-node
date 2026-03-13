/**
 * Ollama LLM provider for pipeline-based voice agents.
 * Uses the OpenAI-compatible API that Ollama exposes.
 */

import type { ConversationMessage, LLM, LLMChunk } from '../base.js';
import type { ToolRegistry } from '../../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface OllamaLLMOptions {
  /** Ollama server URL. Falls back to OLLAMA_BASE_URL env var. Default: 'http://localhost:11434/v1' */
  baseUrl?: string;
  /** Model to use. Default: 'llama3.2' */
  model?: string;
  /** Default temperature. Default: 0.8 */
  temperature?: number;
  /** Default max tokens. Default: 4096 */
  maxTokens?: number;
}

export class OllamaLLM implements LLM {
  private _inner: OpenAICompatLLM;

  constructor(options: OllamaLLMOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1';
    this._inner = new OpenAICompatLLM({
      baseUrl: baseUrl.replace(/\/$/, ''),
      model: options.model ?? 'llama3.2',
      apiKey: 'ollama',
      temperature: options.temperature ?? 0.8,
      maxTokens: options.maxTokens ?? 4096,
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
