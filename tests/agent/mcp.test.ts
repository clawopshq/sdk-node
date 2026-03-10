import { describe, it, expect } from 'vitest';
import { mcpServerStdio, mcpServerHTTP } from '../../src/agent/mcp/index.js';

describe('MCP server config', () => {
  it('MCPServerHTTP stores URL and headers', () => {
    const config = mcpServerHTTP({
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer tok' },
    });
    expect(config.url).toBe('https://mcp.example.com');
    expect(config.type).toBe('http');
    expect(config.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('MCPServerHTTP without headers', () => {
    const config = mcpServerHTTP({ url: 'https://mcp.example.com' });
    expect(config.url).toBe('https://mcp.example.com');
    expect(config.type).toBe('http');
    expect(config.headers).toBeUndefined();
  });

  it('MCPServerStdio stores command and args', () => {
    const config = mcpServerStdio({
      command: 'npx',
      args: ['@mcp/server'],
    });
    expect(config.command).toBe('npx');
    expect(config.type).toBe('stdio');
    expect(config.args).toEqual(['@mcp/server']);
  });

  it('MCPServerStdio stores env', () => {
    const config = mcpServerStdio({
      command: 'node',
      args: ['server.js'],
      env: { NODE_ENV: 'production' },
    });
    expect(config.command).toBe('node');
    expect(config.env).toEqual({ NODE_ENV: 'production' });
  });

  it('MCPServerStdio without optional fields', () => {
    const config = mcpServerStdio({ command: 'my-server' });
    expect(config.command).toBe('my-server');
    expect(config.type).toBe('stdio');
    expect(config.args).toBeUndefined();
    expect(config.env).toBeUndefined();
  });
});
