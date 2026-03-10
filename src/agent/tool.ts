/**
 * Tool registry for function-calling in voice agent pipelines.
 * Uses Zod schemas for parameter validation.
 */

import type { z } from 'zod';

export interface FunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  required: string[];
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/**
 * Decorator / identity function for marking a function as a tool handler.
 * In TypeScript, this simply returns the function as-is. Use with ToolRegistry.register().
 */
export function functionTool<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn;
}

export class ToolRegistry {
  private _tools: Map<string, FunctionTool> = new Map();
  private _mcpTools: Map<string, FunctionTool> = new Map();

  /** Register a function tool. */
  register(tool: FunctionTool): void {
    this._tools.set(tool.name, tool);
  }

  /** Register tools discovered from MCP servers. */
  registerMcpTools(tools: FunctionTool[]): void {
    for (const tool of tools) {
      this._mcpTools.set(tool.name, tool);
    }
  }

  /** Clear all MCP-registered tools. */
  clearMcpTools(): void {
    this._mcpTools.clear();
  }

  /**
   * Create a fork (shallow copy) of this registry.
   * Useful for per-session tool isolation.
   */
  fork(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const [name, tool] of this._tools) {
      copy._tools.set(name, tool);
    }
    for (const [name, tool] of this._mcpTools) {
      copy._mcpTools.set(name, tool);
    }
    return copy;
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this._tools.has(name) || this._mcpTools.has(name);
  }

  /** Get a tool by name. */
  get(name: string): FunctionTool | undefined {
    return this._tools.get(name) ?? this._mcpTools.get(name);
  }

  /** Convert all registered tools to OpenAI function-calling format. */
  toOpenAITools(): OpenAIToolDefinition[] {
    const result: OpenAIToolDefinition[] = [];
    const allTools = [...this._tools.values(), ...this._mcpTools.values()];

    for (const tool of allTools) {
      result.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: tool.parameters,
            required: tool.required,
          },
        },
      });
    }

    return result;
  }

  /** Call a tool by name with the given arguments. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found in registry`);
    }
    return tool.handler(args);
  }

  /** Get the number of registered tools (including MCP). */
  get size(): number {
    return this._tools.size + this._mcpTools.size;
  }
}

/**
 * Helper to convert a Zod object schema into a JSON Schema properties + required list.
 */
export function zodToToolParams(schema: z.ZodObject<z.ZodRawShape>): {
  parameters: Record<string, unknown>;
  required: string[];
} {
  const shape = schema.shape;
  const parameters: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const zodField = field as z.ZodTypeAny;
    const desc = zodField.description;
    let isOptional = false;
    let innerType = zodField;

    // Unwrap ZodOptional
    if ('unwrap' in zodField && zodField._def?.typeName === 'ZodOptional') {
      isOptional = true;
      innerType = (zodField as z.ZodOptional<z.ZodTypeAny>).unwrap();
    }

    const jsonSchema: Record<string, unknown> = {};

    // Map common Zod types to JSON Schema
    const typeName = innerType._def?.typeName as string | undefined;
    switch (typeName) {
      case 'ZodString':
        jsonSchema.type = 'string';
        break;
      case 'ZodNumber':
        jsonSchema.type = 'number';
        break;
      case 'ZodBoolean':
        jsonSchema.type = 'boolean';
        break;
      case 'ZodArray':
        jsonSchema.type = 'array';
        break;
      case 'ZodEnum':
        jsonSchema.type = 'string';
        jsonSchema.enum = innerType._def?.values;
        break;
      default:
        jsonSchema.type = 'string';
    }

    if (desc) {
      jsonSchema.description = desc;
    }

    parameters[key] = jsonSchema;

    if (!isOptional) {
      required.push(key);
    }
  }

  return { parameters, required };
}
