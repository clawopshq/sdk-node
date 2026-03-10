import type { ConversationMessage, LLM, LLMChunk } from './base.js';
import type { ToolRegistry } from '../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface TogetherLLMOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class TogetherLLM implements LLM {
  private _inner: OpenAICompatLLM;

  constructor(options: TogetherLLMOptions = {}) {
    this._inner = new OpenAICompatLLM({
      apiKey: options.apiKey ?? process.env['TOGETHER_API_KEY'],
      baseUrl: 'https://api.together.xyz/v1',
      model: options.model ?? 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
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
