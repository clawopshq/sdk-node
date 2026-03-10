import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMChunk } from '../../src/agent/pipeline/base.js';

// Mock openai – used by all compat LLMs internally
const mockCreate = vi.fn();
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      // Store the config so tests can inspect it
      (mockCreate as unknown as Record<string, unknown>).__lastOpts = opts;
      return {
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      };
    }),
  };
});

import { OllamaLLM } from '../../src/agent/pipeline/ollama-llm.js';
import { MistralLLM } from '../../src/agent/pipeline/mistral-llm.js';
import { GroqLLM } from '../../src/agent/pipeline/groq-llm.js';
import { PerplexityLLM } from '../../src/agent/pipeline/perplexity-llm.js';
import { TogetherLLM } from '../../src/agent/pipeline/together-llm.js';
import { FireworksLLM } from '../../src/agent/pipeline/fireworks-llm.js';
import { DeepSeekLLM } from '../../src/agent/pipeline/deepseek-llm.js';
import { XaiLLM } from '../../src/agent/pipeline/xai-llm.js';

interface ProviderDef {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: () => any;
  expectedBaseUrlContains: string;
  envVar: string;
}

const providers: ProviderDef[] = [
  {
    name: 'OllamaLLM',
    factory: () => new OllamaLLM(),
    expectedBaseUrlContains: 'localhost:11434',
    envVar: 'ollama', // Ollama uses a fixed key
  },
  {
    name: 'MistralLLM',
    factory: () => new MistralLLM({ apiKey: 'test-mistral' }),
    expectedBaseUrlContains: 'api.mistral.ai',
    envVar: 'MISTRAL_API_KEY',
  },
  {
    name: 'GroqLLM',
    factory: () => new GroqLLM({ apiKey: 'test-groq' }),
    expectedBaseUrlContains: 'api.groq.com',
    envVar: 'GROQ_API_KEY',
  },
  {
    name: 'PerplexityLLM',
    factory: () => new PerplexityLLM({ apiKey: 'test-pplx' }),
    expectedBaseUrlContains: 'api.perplexity.ai',
    envVar: 'PERPLEXITY_API_KEY',
  },
  {
    name: 'TogetherLLM',
    factory: () => new TogetherLLM({ apiKey: 'test-together' }),
    expectedBaseUrlContains: 'api.together.xyz',
    envVar: 'TOGETHER_API_KEY',
  },
  {
    name: 'FireworksLLM',
    factory: () => new FireworksLLM({ apiKey: 'test-fireworks' }),
    expectedBaseUrlContains: 'api.fireworks.ai',
    envVar: 'FIREWORKS_API_KEY',
  },
  {
    name: 'DeepSeekLLM',
    factory: () => new DeepSeekLLM({ apiKey: 'test-deepseek' }),
    expectedBaseUrlContains: 'api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
  },
  {
    name: 'XaiLLM',
    factory: () => new XaiLLM({ apiKey: 'test-xai' }),
    expectedBaseUrlContains: 'api.x.ai',
    envVar: 'XAI_API_KEY',
  },
];

describe.each(providers)('$name', ({ factory, expectedBaseUrlContains }) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('implements LLM interface (has generate method)', () => {
    const llm = factory();
    expect(llm.generate).toBeInstanceOf(Function);
  });

  it(`uses correct base URL containing "${expectedBaseUrlContains}"`, async () => {
    const mockStream = (async function* () {
      yield { choices: [{ delta: { content: 'ok' } }] };
    })();
    mockCreate.mockResolvedValue(mockStream);

    const llm = factory();
    // Consume the generator to trigger the OpenAI client creation
    const gen = llm.generate([{ role: 'user', content: 'test' }] as never);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of gen) {
      // consume
    }

    const lastOpts = (mockCreate as unknown as Record<string, unknown>).__lastOpts as Record<
      string,
      unknown
    >;
    expect(lastOpts).toBeDefined();
    expect(String(lastOpts['baseURL'])).toContain(expectedBaseUrlContains);
  });

  it('streams text generation correctly', async () => {
    const mockStream = (async function* () {
      yield { choices: [{ delta: { content: 'Hello' } }] };
      yield { choices: [{ delta: { content: ' there' } }] };
    })();
    mockCreate.mockResolvedValue(mockStream);

    const llm = factory();
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'Hi' }] as never)) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(chunks[1]).toEqual({ type: 'text', text: ' there' });
    expect(chunks[chunks.length - 1].type).toBe('done');
  });

  it('handles tool call generation', async () => {
    const mockStream = (async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'search', arguments: '{"q":"test"}' },
                },
              ],
            },
          },
        ],
      };
    })();
    mockCreate.mockResolvedValue(mockStream);

    const llm = factory();
    const chunks: LLMChunk[] = [];

    for await (const chunk of llm.generate([{ role: 'user', content: 'search' }] as never)) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find((c) => c.type === 'tool_call');
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.toolCall!.name).toBe('search');
    expect(toolChunk!.toolCall!.id).toBe('call_1');
  });
});
