/**
 * Anthropic LLM provider for pipeline-based voice agents.
 */

import type { ConversationMessage, LLM, LLMChunk } from './base.js';
import type { ToolRegistry } from '../tool.js';

export interface AnthropicLLMOptions {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Default: 'claude-sonnet-4-20250514' */
  model?: string;
  /** Default temperature. */
  temperature?: number;
  /** Default max tokens. Default: 1024 */
  maxTokens?: number;
}

export class AnthropicLLM implements LLM {
  private _options: AnthropicLLMOptions;

  constructor(options: AnthropicLLMOptions = {}) {
    this._options = {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1024,
      ...options,
    };
  }

  async *generate(
    messages: ConversationMessage[],
    options?: {
      tools?: ToolRegistry;
      temperature?: number;
      maxTokens?: number;
    },
  ): AsyncGenerator<LLMChunk> {
    const AnthropicModule = await import('@anthropic-ai/sdk');
    const Anthropic = AnthropicModule.default;

    const client = new Anthropic({
      apiKey: this._options.apiKey ?? process.env['ANTHROPIC_API_KEY'],
    });

    // Separate system message from conversation
    let systemPrompt: string | undefined;
    const conversationMessages: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else {
        conversationMessages.push({
          role: msg.role === 'tool' ? 'user' : msg.role,
          content:
            msg.role === 'tool'
              ? [
                  {
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: msg.content,
                  },
                ]
              : msg.content,
        });
      }
    }

    const requestParams: Record<string, unknown> = {
      model: this._options.model,
      messages: conversationMessages,
      max_tokens: options?.maxTokens ?? this._options.maxTokens,
      stream: true,
    };

    if (systemPrompt) {
      requestParams['system'] = systemPrompt;
    }
    if (options?.temperature ?? this._options.temperature) {
      requestParams['temperature'] = options?.temperature ?? this._options.temperature;
    }

    if (options?.tools && options.tools.size > 0) {
      const toolDefs = options.tools.toOpenAITools().map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      requestParams['tools'] = toolDefs;
    }

    const stream = client.messages.stream(
      requestParams as Parameters<typeof client.messages.stream>[0],
    );

    let currentToolCall: { id: string; name: string; arguments: string } | null = null;

    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      const eventType = event['type'] as string;

      switch (eventType) {
        case 'content_block_start': {
          const contentBlock = event['content_block'] as Record<string, unknown>;
          if (contentBlock?.['type'] === 'tool_use') {
            currentToolCall = {
              id: contentBlock['id'] as string,
              name: contentBlock['name'] as string,
              arguments: '',
            };
          }
          break;
        }
        case 'content_block_delta': {
          const delta = event['delta'] as Record<string, unknown>;
          if (delta?.['type'] === 'text_delta') {
            yield { type: 'text', text: delta['text'] as string };
          } else if (delta?.['type'] === 'input_json_delta' && currentToolCall) {
            currentToolCall.arguments += (delta['partial_json'] as string) ?? '';
          }
          break;
        }
        case 'content_block_stop': {
          if (currentToolCall) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: currentToolCall.id,
                name: currentToolCall.name,
                arguments: currentToolCall.arguments,
              },
            };
            currentToolCall = null;
          }
          break;
        }
        case 'message_stop': {
          yield { type: 'done' };
          break;
        }
      }
    }
  }
}
