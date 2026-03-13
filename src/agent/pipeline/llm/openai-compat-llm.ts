/**
 * OpenAI-compatible LLM provider (works with any OpenAI-compatible API).
 */

import type { ConversationMessage, LLM, LLMChunk } from '../base.js';
import type { ToolRegistry } from '../../tool.js';

export interface OpenAICompatLLMOptions {
  /** API key. */
  apiKey?: string;
  /** Base URL for the OpenAI-compatible API. */
  baseUrl: string;
  /** Model to use. */
  model: string;
  /** Default temperature. */
  temperature?: number;
  /** Default max tokens. */
  maxTokens?: number;
  /** Additional default headers. */
  defaultHeaders?: Record<string, string>;
}

export class OpenAICompatLLM implements LLM {
  private _options: OpenAICompatLLMOptions;

  constructor(options: OpenAICompatLLMOptions) {
    this._options = options;
  }

  async *generate(
    messages: ConversationMessage[],
    options?: {
      tools?: ToolRegistry;
      temperature?: number;
      maxTokens?: number;
    },
  ): AsyncGenerator<LLMChunk> {
    const OpenAI = (await import('openai')).default;

    const client = new OpenAI({
      apiKey: this._options.apiKey ?? 'not-needed',
      baseURL: this._options.baseUrl,
      defaultHeaders: this._options.defaultHeaders,
    });

    const requestParams: Record<string, unknown> = {
      model: this._options.model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.name) msg['name'] = m.name;
        if (m.tool_call_id) msg['tool_call_id'] = m.tool_call_id;
        return msg;
      }),
      stream: true,
      temperature: options?.temperature ?? this._options.temperature,
      max_tokens: options?.maxTokens ?? this._options.maxTokens,
    };

    if (options?.tools && options.tools.size > 0) {
      requestParams['tools'] = options.tools.toOpenAITools();
    }

    const stream = await client.chat.completions.create(
      requestParams as Parameters<typeof client.chat.completions.create>[0],
    );

    let currentToolCall: { id: string; name: string; arguments: string } | null = null;

    for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
      const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) continue;

      const delta = choices[0]!['delta'] as Record<string, unknown> | undefined;
      if (!delta) continue;

      const content = delta['content'] as string | undefined;
      if (content) {
        yield { type: 'text', text: content };
      }

      const toolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          const fn = tc['function'] as Record<string, unknown> | undefined;
          if (fn) {
            if (fn['name']) {
              if (currentToolCall) {
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: currentToolCall.id,
                    name: currentToolCall.name,
                    arguments: currentToolCall.arguments,
                  },
                };
              }
              currentToolCall = {
                id: (tc['id'] as string) ?? '',
                name: fn['name'] as string,
                arguments: (fn['arguments'] as string) ?? '',
              };
            } else if (currentToolCall && fn['arguments']) {
              currentToolCall.arguments += fn['arguments'] as string;
            }
          }
        }
      }
    }

    if (currentToolCall) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: currentToolCall.id,
          name: currentToolCall.name,
          arguments: currentToolCall.arguments,
        },
      };
    }

    yield { type: 'done' };
  }
}
