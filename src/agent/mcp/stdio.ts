/**
 * MCP server configuration for stdio-based servers.
 */

export interface MCPServerStdio {
  type: 'stdio';
  /** Command to execute. */
  command: string;
  /** Command arguments. */
  args?: string[];
  /** Environment variables. */
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Create a stdio MCP server configuration.
 */
export function mcpServerStdio(options: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): MCPServerStdio {
  return {
    type: 'stdio',
    command: options.command,
    args: options.args,
    env: options.env,
  };
}
