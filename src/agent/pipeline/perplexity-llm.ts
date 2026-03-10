import type { ConversationMessage, LLM, LLMChunk } from './base.js';
import type { ToolRegistry } from '../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface PerplexityLLMOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class PerplexityLLM implements LLM {
  private _inner: OpenAICompatLLM;

  constructor(options: PerplexityLLMOptions = {}) {
    this._inner = new OpenAICompatLLM({
      apiKey: options.apiKey ?? process.env['PERPLEXITY_API_KEY'],
      baseUrl: 'https://api.perplexity.ai',
      model: options.model ?? 'sonar',
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
  }

  async *generate(
    messages: ConversationMessage[],
    options?: { tools?: ToolRegistry; temperature?: number; maxTokens?: number },
  ): AsyncGenerator<LLMChunk> {
    yield* this._inner.generate(messages, options);
  }
}
