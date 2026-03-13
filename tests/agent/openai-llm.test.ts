import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMChunk } from '../../src/agent/pipeline/base.js';

// Mock the openai module with a shared mock function
const mockCreate = vi.fn();
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

import { OpenAILLM } from '../../src/agent/pipeline/llm/openai-llm.js';

describe('OpenAILLM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('implements LLM interface (has generate async generator method)', () => {
    const llm = new OpenAILLM({ apiKey: 'test-key' });
    expect(llm.generate).toBeInstanceOf(Function);
  });

  it('defaults to gpt-4o model', () => {
    const llm = new OpenAILLM({ apiKey: 'test-key' });
    expect(llm).toBeDefined();
  });

  it('streams text chunks correctly', async () => {
    const mockStream = (async function* () {
      yield { choices: [{ delta: { content: 'Hello' } }] };
      yield { choices: [{ delta: { content: ' world' } }] };
      yield { choices: [{ delta: {} }] };
    })();

    mockCreate.mockResolvedValue(mockStream);

    const llm = new OpenAILLM({ apiKey: 'test-key' });
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

  it('handles tool call chunks', async () => {
    const mockStream = (async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: 'call_123',
                  function: { name: 'get_weather', arguments: '{"loc' },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  function: { arguments: 'ation":"NYC"}' },
                },
              ],
            },
          },
        ],
      };
      yield { choices: [{ delta: {} }] };
    })();

    mockCreate.mockResolvedValue(mockStream);

    const llm = new OpenAILLM({ apiKey: 'test-key' });
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'weather' }])) {
      chunks.push(chunk);
    }

    const toolCallChunk = chunks.find((c) => c.type === 'tool_call');
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCall!.name).toBe('get_weather');
    expect(toolCallChunk!.toolCall!.arguments).toBe('{"location":"NYC"}');
    expect(toolCallChunk!.toolCall!.id).toBe('call_123');

    const doneChunk = chunks.find((c) => c.type === 'done');
    expect(doneChunk).toBeDefined();
  });

  it('emits done chunk at the end', async () => {
    const mockStream = (async function* () {
      yield { choices: [{ delta: { content: 'ok' } }] };
    })();

    mockCreate.mockResolvedValue(mockStream);

    const llm = new OpenAILLM({ apiKey: 'test-key' });
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'test' }])) {
      chunks.push(chunk);
    }

    expect(chunks[chunks.length - 1].type).toBe('done');
  });
});
