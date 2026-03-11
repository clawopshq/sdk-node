import { describe, it, expect, vi } from 'vitest';

// Mock pipeline modules that require external SDKs
vi.mock('../../src/agent/pipeline/openai-realtime.js', () => ({
  OpenAIRealtime: class {
    constructor(public options: Record<string, unknown> = {}) {}
    async start() {}
    async stop() {}
    feedAudio() {}
  },
}));

vi.mock('../../src/agent/pipeline/gemini-realtime.js', () => ({
  GeminiRealtime: class {
    constructor(public options: Record<string, unknown> = {}) {}
    async start() {}
    async stop() {}
    feedAudio() {}
  },
}));

vi.mock('../../src/agent/pipeline/pipeline-session.js', () => ({
  PipelineSession: class {
    constructor(public options: Record<string, unknown> = {}) {}
    async start() {}
    async stop() {}
    feedAudio() {}
  },
}));

vi.mock('../../src/agent/pipeline/deepgram-stt.js', () => ({
  DeepgramSTT: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/elevenlabs-tts.js', () => ({
  ElevenLabsTTS: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/openai-llm.js', () => ({
  OpenAILLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/anthropic-llm.js', () => ({
  AnthropicLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/gemini-llm.js', () => ({
  GeminiLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/openai-compat-llm.js', () => ({
  OpenAICompatLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/ollama-llm.js', () => ({
  OllamaLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/mistral-llm.js', () => ({
  MistralLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/groq-llm.js', () => ({
  GroqLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/perplexity-llm.js', () => ({
  PerplexityLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/together-llm.js', () => ({
  TogetherLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/fireworks-llm.js', () => ({
  FireworksLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/deepseek-llm.js', () => ({
  DeepSeekLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

vi.mock('../../src/agent/pipeline/xai-llm.js', () => ({
  XaiLLM: class {
    constructor(public options: Record<string, unknown> = {}) {}
  },
}));

describe('Agent integration', () => {
  it('full agent setup with tools and events', async () => {
    const { ClawOpsAgent, OpenAIRealtime } = await import('../../src/agent/index.js');
    const session = new OpenAIRealtime({ systemPrompt: 'test' });
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012345678',
      session,
    });
    agent.tool({
      name: 'check',
      description: 'Check order',
      parameters: { id: { type: 'string' } },
      required: ['id'],
      handler: async (args) => `OK ${args.id}`,
    });
    agent.on('call_start', async () => {});
    expect(agent).toBeDefined();
  });

  it('tool execution integration', async () => {
    const { ToolRegistry } = await import('../../src/agent/index.js');
    const registry = new ToolRegistry();
    registry.register({
      name: 'add',
      description: 'Adds numbers',
      parameters: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      handler: async (args) => String(Number(args.a) + Number(args.b)),
    });
    const schema = registry.toOpenAITools();
    expect(schema[0].function.name).toBe('add');
    const result = await registry.call('add', { a: 5, b: 3 });
    expect(result).toBe('8');
  });

  it('CallSession lifecycle', async () => {
    const { CallSession } = await import('../../src/agent/index.js');
    const session = new CallSession({
      callId: 'CA_INT',
      fromNumber: '070',
      toNumber: '010',
      accountId: 'AC',
      direction: 'inbound',
    });
    expect(session.callId).toBe('CA_INT');
    expect(session.direction).toBe('inbound');
    expect(session.duration).toBeGreaterThanOrEqual(0);
    expect(session.status).toBe('ringing');

    // Bind transport
    const sendAudio = vi.fn();
    const clearAudio = vi.fn();
    const hangup = vi.fn();
    session._bindTransport(sendAudio, clearAudio, hangup);
    expect(session.status).toBe('active');
  });

  it('agent with MCP servers config', async () => {
    const { ClawOpsAgent, OpenAIRealtime, mcpServerStdio } = await import(
      '../../src/agent/index.js'
    );
    const session = new OpenAIRealtime({ systemPrompt: 'test' });
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC123',
      from: '07012345678',
      session,
      mcpServers: [
        mcpServerStdio({ command: 'npx', args: ['@mcp/server'] }),
      ],
    });
    expect(agent).toBeDefined();
  });

  it('all public imports are accessible', async () => {
    const agent = await import('../../src/agent/index.js');
    expect(agent.ClawOpsAgent).toBeDefined();
    expect(agent.OpenAIRealtime).toBeDefined();
    expect(agent.GeminiRealtime).toBeDefined();
    expect(agent.PipelineSession).toBeDefined();
    expect(agent.DeepgramSTT).toBeDefined();
    expect(agent.ElevenLabsTTS).toBeDefined();
    expect(agent.OpenAILLM).toBeDefined();
    expect(agent.AnthropicLLM).toBeDefined();
    expect(agent.GeminiLLM).toBeDefined();
    expect(agent.OpenAICompatLLM).toBeDefined();
    expect(agent.OllamaLLM).toBeDefined();
    expect(agent.MistralLLM).toBeDefined();
    expect(agent.GroqLLM).toBeDefined();
    expect(agent.PerplexityLLM).toBeDefined();
    expect(agent.TogetherLLM).toBeDefined();
    expect(agent.FireworksLLM).toBeDefined();
    expect(agent.DeepSeekLLM).toBeDefined();
    expect(agent.XaiLLM).toBeDefined();
    expect(agent.CallSession).toBeDefined();
    expect(agent.ToolRegistry).toBeDefined();
    expect(agent.AudioRecorder).toBeDefined();
    expect(agent.MCPClient).toBeDefined();
    expect(agent.pcm16ToUlaw).toBeDefined();
    expect(agent.ulawToPcm16).toBeDefined();
    expect(agent.mcpServerStdio).toBeDefined();
    expect(agent.mcpServerHTTP).toBeDefined();
    expect(agent.functionTool).toBeDefined();
    expect(agent.zodToToolParams).toBeDefined();
    expect(agent.setTracingConfig).toBeDefined();
    expect(agent.getTracingConfig).toBeDefined();
    expect(agent.resetTracingConfig).toBeDefined();
  });
});
