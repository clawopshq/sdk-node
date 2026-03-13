/**
 * Agent public API exports.
 */

// Core
export { ClawOpsAgent } from './agent.js';
export type { ClawOpsAgentOptions, AgentEventType } from './agent.js';

// Session
export { CallSession } from './session.js';
export type { CallDirection, CallStatus } from './session.js';

// Tools
export { ToolRegistry, functionTool, zodToToolParams } from './tool.js';
export type { FunctionTool, OpenAIToolDefinition } from './tool.js';

// Built-in Tools
export { BuiltinTool } from './builtin-tool.js';

// Audio utilities
export { pcm16ToUlaw, ulawToPcm16, resamplePcm16, DECODE_TABLE } from './audio.js';

// Recorder
export { AudioRecorder } from './recorder.js';

// Pipeline
export * from './pipeline/index.js';

// Logger
export type { Logger } from './logger.js';
export { createAgentLogger, createPipelineLogger } from './logger.js';

// MCP
export { MCPClient, mcpServerStdio, mcpServerHTTP } from './mcp/index.js';
export type { MCPServerConfig, MCPServerStdio, MCPServerHTTP } from './mcp/index.js';

// Tracing
export type { TracingConfig } from './tracing/index.js';
export { setTracingConfig, getTracingConfig, resetTracingConfig } from './tracing/index.js';
