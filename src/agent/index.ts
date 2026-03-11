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

// Audio utilities
export { pcm16ToUlaw, ulawToPcm16, resamplePcm16, DECODE_TABLE } from './audio.js';

// Recorder
export { AudioRecorder } from './recorder.js';

// Pipeline
export type { Session, STT, LLM, TTS, SpeechEvent, ConversationMessage, LLMChunk } from './pipeline/index.js';
export { OpenAIRealtime } from './pipeline/index.js';
export type { OpenAIRealtimeOptions } from './pipeline/index.js';
export { GeminiRealtime } from './pipeline/index.js';
export type { GeminiRealtimeOptions } from './pipeline/index.js';
export { PipelineSession } from './pipeline/index.js';
export type { PipelineSessionOptions } from './pipeline/index.js';
export { DeepgramSTT } from './pipeline/index.js';
export type { DeepgramSTTOptions } from './pipeline/index.js';
export { ElevenLabsTTS } from './pipeline/index.js';
export type { ElevenLabsTTSOptions } from './pipeline/index.js';
export { OpenAILLM } from './pipeline/index.js';
export type { OpenAILLMOptions } from './pipeline/index.js';
export { AnthropicLLM } from './pipeline/index.js';
export type { AnthropicLLMOptions } from './pipeline/index.js';
export { GeminiLLM } from './pipeline/index.js';
export type { GeminiLLMOptions } from './pipeline/index.js';
export { OpenAICompatLLM } from './pipeline/index.js';
export type { OpenAICompatLLMOptions } from './pipeline/index.js';
export { OllamaLLM } from './pipeline/index.js';
export type { OllamaLLMOptions } from './pipeline/index.js';
export { MistralLLM } from './pipeline/index.js';
export type { MistralLLMOptions } from './pipeline/index.js';
export { GroqLLM } from './pipeline/index.js';
export type { GroqLLMOptions } from './pipeline/index.js';
export { PerplexityLLM } from './pipeline/index.js';
export type { PerplexityLLMOptions } from './pipeline/index.js';
export { TogetherLLM } from './pipeline/index.js';
export type { TogetherLLMOptions } from './pipeline/index.js';
export { FireworksLLM } from './pipeline/index.js';
export type { FireworksLLMOptions } from './pipeline/index.js';
export { DeepSeekLLM } from './pipeline/index.js';
export type { DeepSeekLLMOptions } from './pipeline/index.js';
export { XaiLLM } from './pipeline/index.js';
export type { XaiLLMOptions } from './pipeline/index.js';

// MCP
export { MCPClient, mcpServerStdio, mcpServerHTTP } from './mcp/index.js';
export type { MCPServerConfig, MCPServerStdio, MCPServerHTTP } from './mcp/index.js';

// Tracing
export type { TracingConfig } from './tracing/index.js';
export { setTracingConfig, getTracingConfig, resetTracingConfig } from './tracing/index.js';
