import type { ConversationMessage, LLM, LLMChunk } from '../base.js';
import type { ToolRegistry } from '../../tool.js';
import { OpenAICompatLLM } from './openai-compat-llm.js';

export interface GroqLLMOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class GroqLLM implements LLM {
  private _inner: OpenAICompatLLM;

  get provider(): string { return 'groq'; }
  get model(): string { return this._inner.model; }

  constructor(options: GroqLLMOptions = {}) {
    this._inner = new OpenAICompatLLM({
      apiKey: options.apiKey ?? process.env['GROQ_API_KEY'],
      baseUrl: 'https://api.groq.com/openai/v1',
      model: options.model ?? 'meta-llama/llama-4-scout-17b-16e-instruct',
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
