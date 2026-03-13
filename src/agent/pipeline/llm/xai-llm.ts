import type { ConversationMessage, LLM, LLMChunk } from '../base.js';
import type { ToolRegistry } from '../../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface XaiLLMOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class XaiLLM implements LLM {
  private _inner: OpenAICompatLLM;

  constructor(options: XaiLLMOptions = {}) {
    this._inner = new OpenAICompatLLM({
      apiKey: options.apiKey ?? process.env['XAI_API_KEY'],
      baseUrl: 'https://api.x.ai/v1',
      model: options.model ?? 'grok-4-1-fast',
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
