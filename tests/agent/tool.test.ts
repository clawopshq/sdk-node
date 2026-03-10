import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool.js';
import type { FunctionTool } from '../../src/agent/tool.js';

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  required: string[] = [],
): FunctionTool {
  return { name, description, parameters, required, handler };
}

describe('ToolRegistry', () => {
  it('registers a function tool', () => {
    const registry = new ToolRegistry();
    const tool = makeTool('greet', 'Says hello', { name: { type: 'string' } }, async ({ name }) => `Hello ${name}`);
    registry.register(tool);
    const tools = registry.toOpenAITools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('greet');
  });

  it('generates correct OpenAI tool schema', () => {
    const registry = new ToolRegistry();
    const tool = makeTool(
      'search',
      'Searches',
      { query: { type: 'string' }, limit: { type: 'number' } },
      async () => 'ok',
      ['query'],
    );
    registry.register(tool);
    const schema = registry.toOpenAITools()[0];
    expect(schema.type).toBe('function');
    expect(schema.function.parameters.properties).toHaveProperty('query');
    expect(schema.function.parameters.properties).toHaveProperty('limit');
  });

  it('calls a registered tool', async () => {
    const registry = new ToolRegistry();
    const tool = makeTool(
      'add',
      'Adds',
      { a: { type: 'number' }, b: { type: 'number' } },
      async ({ a, b }) => String((a as number) + (b as number)),
    );
    registry.register(tool);
    const result = await registry.call('add', { a: 1, b: 2 });
    expect(result).toBe('3');
  });

  it('throws on non-existent tool', async () => {
    const registry = new ToolRegistry();
    await expect(registry.call('nope', {})).rejects.toThrow();
  });

  it('registers MCP tools', () => {
    const mcpTools: FunctionTool[] = [
      makeTool('web_search', 'Search the web', { q: { type: 'string' } }, async () => 'result', ['q']),
    ];
    const registry = new ToolRegistry();
    registry.registerMcpTools(mcpTools);
    const tools = registry.toOpenAITools();
    expect(tools.some((t) => t.function.name === 'web_search')).toBe(true);
  });

  it('overwrites tool on duplicate register', () => {
    const registry = new ToolRegistry();
    const tool1 = makeTool('dup', 'First', {}, async () => 'first');
    const tool2 = makeTool('dup', 'Second', {}, async () => 'second');
    registry.register(tool1);
    registry.register(tool2);
    const tools = registry.toOpenAITools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.description).toBe('Second');
  });

  it('calls MCP tool via registry', async () => {
    const handler = vi.fn().mockResolvedValue('mcp result');
    const mcpTools: FunctionTool[] = [
      makeTool('mcp_fn', 'MCP function', {}, handler),
    ];
    const registry = new ToolRegistry();
    registry.registerMcpTools(mcpTools);
    const result = await registry.call('mcp_fn', { key: 'val' });
    expect(handler).toHaveBeenCalledWith({ key: 'val' });
    expect(result).toBe('mcp result');
  });

  it('clears MCP tools', () => {
    const mcpTools: FunctionTool[] = [
      makeTool('temp', 'Temp', {}, async () => 'ok'),
    ];
    const registry = new ToolRegistry();
    registry.registerMcpTools(mcpTools);
    expect(registry.toOpenAITools()).toHaveLength(1);
    registry.clearMcpTools();
    expect(registry.toOpenAITools()).toHaveLength(0);
  });

  it('fork creates independent copy', () => {
    const registry = new ToolRegistry();
    const tool = makeTool('base', 'Base', {}, async () => 'ok');
    registry.register(tool);
    const forked = registry.fork();
    const mcpTools: FunctionTool[] = [
      makeTool('mcp_only', 'Only in fork', {}, async () => 'ok'),
    ];
    forked.registerMcpTools(mcpTools);
    expect(forked.toOpenAITools()).toHaveLength(2);
    expect(registry.toOpenAITools()).toHaveLength(1);
  });

  it('includes both local and MCP tools in schema', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('local', 'Local', {}, async () => 'ok'));
    registry.registerMcpTools([makeTool('remote', 'Remote', {}, async () => 'ok')]);
    const tools = registry.toOpenAITools();
    expect(tools).toHaveLength(2);
    expect(
      tools
        .map((t) => t.function.name)
        .sort(),
    ).toEqual(['local', 'remote']);
  });
});
