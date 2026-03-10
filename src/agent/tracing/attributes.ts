/**
 * OpenTelemetry semantic attribute constants for ClawOps agent tracing.
 */

// Call attributes
export const ATTR_CALL_ID = 'clawops.call.id';
export const ATTR_CALL_DIRECTION = 'clawops.call.direction';
export const ATTR_CALL_FROM = 'clawops.call.from';
export const ATTR_CALL_TO = 'clawops.call.to';
export const ATTR_CALL_STATUS = 'clawops.call.status';
export const ATTR_CALL_DURATION = 'clawops.call.duration';

// Agent attributes
export const ATTR_AGENT_ID = 'clawops.agent.id';
export const ATTR_AGENT_SESSION_TYPE = 'clawops.agent.session_type';

// Pipeline attributes
export const ATTR_STT_PROVIDER = 'clawops.stt.provider';
export const ATTR_STT_MODEL = 'clawops.stt.model';
export const ATTR_STT_LANGUAGE = 'clawops.stt.language';
export const ATTR_STT_TRANSCRIPT = 'clawops.stt.transcript';

export const ATTR_LLM_PROVIDER = 'clawops.llm.provider';
export const ATTR_LLM_MODEL = 'clawops.llm.model';
export const ATTR_LLM_PROMPT_TOKENS = 'clawops.llm.prompt_tokens';
export const ATTR_LLM_COMPLETION_TOKENS = 'clawops.llm.completion_tokens';
export const ATTR_LLM_TOTAL_TOKENS = 'clawops.llm.total_tokens';

export const ATTR_TTS_PROVIDER = 'clawops.tts.provider';
export const ATTR_TTS_VOICE = 'clawops.tts.voice';
export const ATTR_TTS_MODEL = 'clawops.tts.model';

// Tool attributes
export const ATTR_TOOL_NAME = 'clawops.tool.name';
export const ATTR_TOOL_RESULT = 'clawops.tool.result';
export const ATTR_TOOL_ERROR = 'clawops.tool.error';

// MCP attributes
export const ATTR_MCP_SERVER_NAME = 'clawops.mcp.server_name';
export const ATTR_MCP_SERVER_TYPE = 'clawops.mcp.server_type';

// Audio attributes
export const ATTR_AUDIO_SAMPLE_RATE = 'clawops.audio.sample_rate';
export const ATTR_AUDIO_ENCODING = 'clawops.audio.encoding';
export const ATTR_AUDIO_DURATION = 'clawops.audio.duration';
