/**
 * MCP (Model Context Protocol) client for discovering and calling tools.
 */

import type { FunctionTool } from '../tool.js';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';

export interface MCPServerConfig {
  /** Server type discriminator. */
  type: 'stdio' | 'http';
  [key: string]: unknown;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export class MCPClient {
  private _servers: Map<string, MCPServerConfig & Record<string, unknown>> = new Map();
  private _clients: Map<string, unknown> = new Map();
  private _log: Logger = NOOP_LOGGER;

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  /** Add an MCP server configuration. */
  addServer(name: string, config: MCPServerConfig & Record<string, unknown>): void {
    this._servers.set(name, config);
  }

  /** Connect to all configured MCP servers and discover tools. */
  async connect(): Promise<FunctionTool[]> {
    const allTools: FunctionTool[] = [];

    for (const [name, config] of this._servers) {
      try {
        const tools = await this._connectServer(name, config);
        allTools.push(...tools);
      } catch (err) {
        this._log.error({ err }, 'MCP connection failed: %s', name);
      }
    }

    return allTools;
  }

  /** Disconnect from all MCP servers. */
  async disconnect(): Promise<void> {
    for (const [name, client] of this._clients) {
      try {
        this._log.debug('MCP closing: %s', name);
        const c = client as { close?: () => Promise<void> };
        if (c.close) {
          await c.close();
        }
      } catch (err) {
        this._log.error({ err }, 'MCP disconnect error: %s', name);
      }
    }
    this._clients.clear();
  }

  private async _connectServer(
    name: string,
    config: MCPServerConfig & Record<string, unknown>,
  ): Promise<FunctionTool[]> {
    // Dynamic import to keep @modelcontextprotocol/sdk optional
    const sdk = await import('@modelcontextprotocol/sdk/client/index.js');
    const { Client } = sdk;

    const client = new Client({ name: `clawops-${name}`, version: '1.0.0' });

    if (config.type === 'stdio') {
      this._log.debug('MCP connecting (stdio): %s', config['command']);
    } else if (config.type === 'http') {
      this._log.debug('MCP connecting (http): %s', config['url']);
    }

    let transport: unknown;

    if (config.type === 'stdio') {
      const { StdioClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/stdio.js'
      );
      transport = new StdioClientTransport({
        command: config['command'] as string,
        args: (config['args'] as string[]) ?? [],
        env: config['env'] as Record<string, string> | undefined,
      });
    } else if (config.type === 'http') {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      transport = new StreamableHTTPClientTransport(
        new URL(config['url'] as string),
      );
    } else {
      throw new Error(`Unsupported MCP server type: ${config.type}`);
    }

    await client.connect(transport as Parameters<typeof client.connect>[0]);
    this._clients.set(name, client);

    // Discover tools
    const toolsResult = await client.listTools();
    const tools: FunctionTool[] = [];

    for (const toolDef of toolsResult.tools) {
      const inputSchema = toolDef.inputSchema as MCPToolDefinition['inputSchema'];
      tools.push({
        name: toolDef.name,
        description: toolDef.description ?? '',
        parameters: inputSchema.properties ?? {},
        required: inputSchema.required ?? [],
        handler: async (args: Record<string, unknown>) => {
          this._log.debug('MCP call_tool: %s', toolDef.name);
          const result = await client.callTool({
            name: toolDef.name,
            arguments: args,
          });
          // Extract text content from the result
          const content = result.content as Array<{ type: string; text?: string }>;
          if (content && content.length > 0) {
            return content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
          }
          return JSON.stringify(result);
        },
      });
    }

    this._log.info('MCP server connected: %d tools found', tools.length);
    this._log.debug('MCP tools: %s', tools.map(t => t.name));

    return tools;
  }
}
