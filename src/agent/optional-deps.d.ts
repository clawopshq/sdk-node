// Type declarations for optional peer dependencies.
// These modules are dynamically imported at runtime and may not be installed.

declare module 'openai' {
  export default class OpenAI {
    constructor(options?: Record<string, unknown>);
    chat: {
      completions: {
        create(params: Record<string, unknown>): Promise<AsyncIterable<Record<string, unknown>>>;
      };
    };
  }
}

declare module '@anthropic-ai/sdk' {
  export default class Anthropic {
    constructor(options?: Record<string, unknown>);
    messages: {
      stream(params: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
    };
  }
}

declare module '@google/genai' {
  export class GoogleGenAI {
    constructor(options?: Record<string, unknown>);
    models: {
      generateContentStream(
        params: Record<string, unknown>,
      ): Promise<AsyncIterable<Record<string, unknown>>>;
    };
  }
}

declare module '@opentelemetry/api' {
  export const trace: {
    getTracerProvider(): unknown;
  };
}

declare module '@modelcontextprotocol/sdk/client/index.js' {
  export class Client {
    constructor(options: Record<string, unknown>);
    connect(transport: unknown): Promise<void>;
    listTools(): Promise<{
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }>;
    }>;
    callTool(params: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
    close?(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  export class StdioClientTransport {
    constructor(options: Record<string, unknown>);
  }
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  export class StreamableHTTPClientTransport {
    constructor(url: URL);
  }
}

// LiveKit Agents transport (src/agent/livekit/*). ~네이티브 바이너리를 끌어오므로
// optional peer 로만 선언하고, 런타임에서 `await import(...)` + `as any` 로 다룬다.
declare module '@livekit/agents' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const voice: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const llm: any;
}

declare module '@livekit/rtc-node' {
  export class AudioFrame {
    constructor(data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number);
    data: Int16Array;
    sampleRate: number;
    channels: number;
    samplesPerChannel: number;
  }
}
