/**
 * Agent public API exports.
 */

// Core
import { clearStaleReadyMarker } from './deploy-checks.js';

// **Clear a stale readiness marker at import time.**
//
// Importing this module means a new agent process has started, so whatever readiness marker is
// still on disk belongs, by definition, to a previous one.
//
// Deferring it to the ClawOpsAgent constructor or to connect() is too late — the heavy imports
// and the model clients warming up happen *before* either. A read-only-rootfs deploy commonly
// mounts an emptyDir at /tmp, and that volume outlives a container restart: after a SIGKILL the
// previous marker is still there and the pod goes Ready in the meantime.
//
// Measured on kind, 2026-09-10: clearing it in the constructor left the pod Ready (t+26.6s)
// **12 seconds before it connected** (t+38.7s). Every call in those 12 seconds died.
clearStaleReadyMarker();

export { ClawOpsAgent } from './agent.js';
export type { ClawOpsAgentOptions, AgentEventType, ToolConfig } from './agent.js';

// Session
export { CallSession, DtmfCollectorBusyError } from './session.js';
export type { CallDirection, CallStatus } from './session.js';

// Control WebSocket — account-wide call event stream. Useful for multi-tenant
// workers that dispatch per-call configuration dynamically instead of binding
// one ClawOpsAgent per number.
export { ControlWebSocket, buildControlWsUrl } from './control-ws.js';
export type { ControlWsOptions, ControlEvent } from './control-ws.js';

// Media WebSocket
export { MediaWebSocket } from './media-ws.js';
export type { MediaStartEvent, MediaEvent, DtmfEvent } from './media-ws.js';

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
