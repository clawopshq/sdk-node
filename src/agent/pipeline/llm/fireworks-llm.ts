import type { ConversationMessage, LLM, LLMChunk } from '../base.js';
import type { ToolRegistry } from '../../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface FireworksLLMOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class FireworksLLM implements LLM {
  private _inner: OpenAICompatLLM;

  get provider(): string { return 'fireworks'; }
  get model(): string { return this._inner.model; }

  constructor(options: FireworksLLMOptions = {}) {
    this._inner = new OpenAICompatLLM({
      apiKey: options.apiKey ?? process.env['FIREWORKS_API_KEY'],
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: options.model ?? 'accounts/fireworks/models/llama4-scout-instruct-basic',
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
