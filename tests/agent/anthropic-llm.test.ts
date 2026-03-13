import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMChunk } from '../../src/agent/pipeline/base.js';

// Mock the @anthropic-ai/sdk module
const mockStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        stream: mockStream,
      },
    })),
  };
});

import { AnthropicLLM } from '../../src/agent/pipeline/llm/anthropic-llm.js';

describe('AnthropicLLM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('implements LLM interface (has generate async generator method)', () => {
    const llm = new AnthropicLLM({ apiKey: 'test-key' });
    expect(llm.generate).toBeInstanceOf(Function);
  });

  it('is constructable with default options', () => {
    const llm = new AnthropicLLM({ apiKey: 'test-key' });
    expect(llm).toBeDefined();
  });

  it('streams text chunks via content_block_delta events', async () => {
    const fakeStream = (async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } };
      yield { type: 'message_stop' };
    })();

    mockStream.mockReturnValue(fakeStream);

    const llm = new AnthropicLLM({ apiKey: 'test-key' });
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'Hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'done' },
    ]);
  });

  it('handles tool_use content blocks', async () => {
    const fakeStream = (async function* () {
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_123', name: 'get_weather' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"city"' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: ':"NYC"}' },
      };
      yield { type: 'content_block_stop' };
      yield { type: 'message_stop' };
    })();

    mockStream.mockReturnValue(fakeStream);

    const llm = new AnthropicLLM({ apiKey: 'test-key' });
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'weather' }])) {
      chunks.push(chunk);
    }

    const toolCallChunk = chunks.find((c) => c.type === 'tool_call');
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCall!.name).toBe('get_weather');
    expect(toolCallChunk!.toolCall!.id).toBe('toolu_123');
    expect(toolCallChunk!.toolCall!.arguments).toBe('{"city":"NYC"}');

    const doneChunk = chunks.find((c) => c.type === 'done');
    expect(doneChunk).toBeDefined();
  });

  it('separates system messages from conversation messages', async () => {
    const fakeStream = (async function* () {
      yield { type: 'message_stop' };
    })();

    mockStream.mockReturnValue(fakeStream);

    const llm = new AnthropicLLM({ apiKey: 'test-key' });
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hi' },
    ])) {
      chunks.push(chunk);
    }

    // Should reach done without error - system message is handled separately
    expect(chunks).toEqual([{ type: 'done' }]);
  });
});
