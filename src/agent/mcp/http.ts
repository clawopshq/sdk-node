/**
 * MCP server configuration for HTTP-based servers.
 */

export interface MCPServerHTTP {
  type: 'http';
  /** Server URL. */
  url: string;
  /** Additional headers to send with requests. */
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Create an HTTP MCP server configuration.
 */
export function mcpServerHTTP(options: {
  url: string;
  headers?: Record<string, string>;
}): MCPServerHTTP {
  return {
    type: 'http',
    url: options.url,
    headers: options.headers,
  };
}
