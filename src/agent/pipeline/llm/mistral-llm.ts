import type { ConversationMessage, LLM, LLMChunk } from '../base.js';
import type { ToolRegistry } from '../../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface MistralLLMOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class MistralLLM implements LLM {
  private _inner: OpenAICompatLLM;

  constructor(options: MistralLLMOptions = {}) {
    this._inner = new OpenAICompatLLM({
      apiKey: options.apiKey ?? process.env['MISTRAL_API_KEY'],
      baseUrl: 'https://api.mistral.ai/v1',
      model: options.model ?? 'mistral-small-latest',
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
