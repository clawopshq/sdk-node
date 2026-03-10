import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK modules
const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

const MockClient = vi.fn().mockImplementation(() => ({
  connect: mockConnect,
  listTools: mockListTools,
  callTool: mockCallTool,
  close: mockClose,
}));

const MockStdioTransport = vi.fn();
const MockHTTPTransport = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: MockStdioTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockHTTPTransport,
}));

import { MCPClient } from '../../src/agent/mcp/client.js';

describe('MCPClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({ tools: [] });
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  it('initializes with stdio server config', () => {
    const client = new MCPClient();
    client.addServer('test', { type: 'stdio', command: 'npx', args: ['@mcp/server'] });
    expect(client).toBeDefined();
  });

  it('initializes with HTTP server config', () => {
    const client = new MCPClient();
    client.addServer('test', { type: 'http', url: 'https://mcp.example.com' });
    expect(client).toBeDefined();
  });

  it('connect discovers tools (stdio)', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
    });

    const client = new MCPClient();
    client.addServer('weather', { type: 'stdio', command: 'weather-server' });
    const tools = await client.connect();

    expect(MockStdioTransport).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get_weather');
  });

  it('connect discovers tools (HTTP)', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'search',
          description: 'Search the web',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
    });

    const client = new MCPClient();
    client.addServer('search', { type: 'http', url: 'https://search.example.com' });
    const tools = await client.connect();

    expect(MockHTTPTransport).toHaveBeenCalled();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('search');
  });

  it('connect lists multiple tools from multiple servers', async () => {
    let callCount = 0;
    mockListTools.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          tools: [
            { name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {}, required: [] } },
          ],
        };
      }
      return {
        tools: [
          { name: 'tool_b', description: 'B', inputSchema: { type: 'object', properties: {}, required: [] } },
          { name: 'tool_c', description: 'C', inputSchema: { type: 'object', properties: {}, required: [] } },
        ],
      };
    });

    const client = new MCPClient();
    client.addServer('s1', { type: 'stdio', command: 'server1' });
    client.addServer('s2', { type: 'stdio', command: 'server2' });
    const tools = await client.connect();

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('call tool returns result via handler', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'echo',
          description: 'Echo back',
          inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        },
      ],
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'hello world' }],
    });

    const client = new MCPClient();
    client.addServer('echo', { type: 'stdio', command: 'echo-server' });
    const tools = await client.connect();

    const result = await tools[0].handler({ msg: 'hello' });
    expect(result).toBe('hello world');
    expect(mockCallTool).toHaveBeenCalledWith({ name: 'echo', arguments: { msg: 'hello' } });
  });

  it('call tool returns empty string when no text content in array', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'binary',
          description: 'Binary tool',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'image', data: 'base64data' }],
    });

    const client = new MCPClient();
    client.addServer('bin', { type: 'stdio', command: 'bin-server' });
    const tools = await client.connect();

    const result = await tools[0].handler({});
    // Content array exists with items, but none are text type -> filter returns empty -> join returns ''
    expect(result).toBe('');
  });

  it('disconnect cleans up clients', async () => {
    mockListTools.mockResolvedValue({ tools: [] });

    const client = new MCPClient();
    client.addServer('s1', { type: 'stdio', command: 'server1' });
    await client.connect();
    await client.disconnect();

    expect(mockClose).toHaveBeenCalled();
  });

  it('disconnect without connect is safe', async () => {
    const client = new MCPClient();
    // Should not throw
    await expect(client.disconnect()).resolves.toBeUndefined();
  });
});
