/**
 * Google Gemini LLM provider for pipeline-based voice agents.
 */

import type { ConversationMessage, LLM, LLMChunk } from './base.js';
import type { ToolRegistry } from '../tool.js';

export interface GeminiLLMOptions {
  /** Google API key. Falls back to GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Default: 'gemini-2.5-flash' */
  model?: string;
  /** Default temperature. Default: 0.8 */
  temperature?: number;
  /** Default max tokens. Default: 4096 */
  maxTokens?: number;
}

export class GeminiLLM implements LLM {
  private _options: GeminiLLMOptions;

  constructor(options: GeminiLLMOptions = {}) {
    this._options = {
      model: 'gemini-2.5-flash',
      temperature: 0.8,
      maxTokens: 4096,
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
    const { GoogleGenAI } = await import('@google/genai');

    const client = new GoogleGenAI({
      apiKey: this._options.apiKey ?? process.env['GOOGLE_API_KEY'],
    });

    // Convert messages to Gemini format
    let systemInstruction: string | undefined;
    const contents: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({
        role,
        parts: [{ text: msg.content }],
      });
    }

    const requestConfig: Record<string, unknown> = {
      contents,
    };

    if (systemInstruction) {
      requestConfig['systemInstruction'] = { parts: [{ text: systemInstruction }] };
    }

    const generationConfig: Record<string, unknown> = {};
    if (options?.temperature ?? this._options.temperature) {
      generationConfig['temperature'] = options?.temperature ?? this._options.temperature;
    }
    if (options?.maxTokens ?? this._options.maxTokens) {
      generationConfig['maxOutputTokens'] = options?.maxTokens ?? this._options.maxTokens;
    }
    if (Object.keys(generationConfig).length > 0) {
      requestConfig['generationConfig'] = generationConfig;
    }

    if (options?.tools && options.tools.size > 0) {
      const toolDefs = options.tools.toOpenAITools().map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
      requestConfig['tools'] = [{ functionDeclarations: toolDefs }];
    }

    const response = await client.models.generateContentStream({
      model: this._options.model!,
      ...requestConfig,
    });

    for await (const chunk of response) {
      const candidates = (chunk as Record<string, unknown>)['candidates'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (!candidates || candidates.length === 0) continue;

      const content = candidates[0]?.['content'] as Record<string, unknown> | undefined;
      const parts = content?.['parts'] as Array<Record<string, unknown>> | undefined;
      if (!parts) continue;

      for (const part of parts) {
        if ('text' in part && part['text']) {
          yield { type: 'text', text: part['text'] as string };
        }

        if ('functionCall' in part && part['functionCall']) {
          const fc = part['functionCall'] as { name: string; args: Record<string, unknown> };
          yield {
            type: 'tool_call',
            toolCall: {
              id: `gemini_${Date.now()}`,
              name: fc.name,
              arguments: JSON.stringify(fc.args ?? {}),
            },
          };
        }
      }
    }

    yield { type: 'done' };
  }
}
