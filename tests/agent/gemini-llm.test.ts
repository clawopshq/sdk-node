import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMChunk } from '../../src/agent/pipeline/base.js';

// Mock @google/genai
const mockGenerateContentStream = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContentStream: mockGenerateContentStream,
      },
    })),
  };
});

import { GeminiLLM } from '../../src/agent/pipeline/llm/gemini-llm.js';

describe('GeminiLLM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('implements LLM interface (has generate async generator method)', () => {
    const llm = new GeminiLLM({ apiKey: 'test-key' });
    expect(llm.generate).toBeInstanceOf(Function);
  });

  it('defaults to gemini-2.0-flash model', () => {
    const llm = new GeminiLLM({ apiKey: 'test-key' });
    expect(llm).toBeDefined();
  });

  it('streams text parts correctly', async () => {
    const fakeStream = (async function* () {
      yield {
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
      };
      yield {
        candidates: [{ content: { parts: [{ text: ' world' }] } }],
      };
    })();

    mockGenerateContentStream.mockResolvedValue(fakeStream);

    const llm = new GeminiLLM({ apiKey: 'test-key' });
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

  it('handles function call parsing', async () => {
    const fakeStream = (async function* () {
      yield {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: { city: 'NYC' },
                  },
                },
              ],
            },
          },
        ],
      };
    })();

    mockGenerateContentStream.mockResolvedValue(fakeStream);

    const llm = new GeminiLLM({ apiKey: 'test-key' });
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'weather' }])) {
      chunks.push(chunk);
    }

    const toolCallChunk = chunks.find((c) => c.type === 'tool_call');
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCall!.name).toBe('get_weather');
    expect(JSON.parse(toolCallChunk!.toolCall!.arguments)).toEqual({ city: 'NYC' });

    const doneChunk = chunks.find((c) => c.type === 'done');
    expect(doneChunk).toBeDefined();
  });

  it('skips chunks with no candidates', async () => {
    const fakeStream = (async function* () {
      yield { candidates: [] };
      yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
    })();

    mockGenerateContentStream.mockResolvedValue(fakeStream);

    const llm = new GeminiLLM({ apiKey: 'test-key' });
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'test' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ type: 'text', text: 'ok' }, { type: 'done' }]);
  });
});
