import type { ConversationMessage, LLM, LLMChunk } from '../base.js';
import type { ToolRegistry } from '../../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface DeepSeekLLMOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class DeepSeekLLM implements LLM {
  private _inner: OpenAICompatLLM;

  get provider(): string { return 'deepseek'; }
  get model(): string { return this._inner.model; }

  constructor(options: DeepSeekLLMOptions = {}) {
    this._inner = new OpenAICompatLLM({
      apiKey: options.apiKey ?? process.env['DEEPSEEK_API_KEY'],
      baseUrl: 'https://api.deepseek.com',
      model: options.model ?? 'deepseek-chat',
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
