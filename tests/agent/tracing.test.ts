import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTracingConfig,
  setTracingConfig,
  resetTracingConfig,
  ATTR_CALL_ID,
  ATTR_CALL_FROM,
  ATTR_CALL_TO,
  ATTR_CALL_DURATION,
  ATTR_CALL_DIRECTION,
  ATTR_CALL_STATUS,
  ATTR_LLM_PROVIDER,
  ATTR_LLM_MODEL,
  ATTR_LLM_PROMPT_TOKENS,
  ATTR_LLM_COMPLETION_TOKENS,
  ATTR_LLM_TOTAL_TOKENS,
  ATTR_MCP_SERVER_TYPE,
  ATTR_MCP_SERVER_NAME,
  ATTR_TOOL_NAME,
  ATTR_TOOL_RESULT,
  ATTR_TOOL_ERROR,
  ATTR_AGENT_ID,
  ATTR_AGENT_SESSION_TYPE,
  ATTR_STT_PROVIDER,
  ATTR_TTS_PROVIDER,
  ATTR_AUDIO_SAMPLE_RATE,
  startSpan,
  withSpan,
} from '../../src/agent/tracing/index.js';

describe('Tracing', () => {
  beforeEach(() => {
    resetTracingConfig();
  });

  it('TracingConfig default values (enabled=false, serviceName=clawops-agent)', () => {
    const config = getTracingConfig();
    expect(config.enabled).toBe(false);
    expect(config.serviceName).toBe('clawops-agent');
  });

  it('TracingConfig custom values', () => {
    setTracingConfig({ enabled: true, serviceName: 'my-service' });
    const config = getTracingConfig();
    expect(config.enabled).toBe(true);
    expect(config.serviceName).toBe('my-service');
  });

  it('Call attributes exist', () => {
    expect(ATTR_CALL_ID).toBe('clawops.call.id');
    expect(ATTR_CALL_FROM).toBe('clawops.call.from');
    expect(ATTR_CALL_TO).toBe('clawops.call.to');
    expect(ATTR_CALL_DURATION).toBe('clawops.call.duration');
    expect(ATTR_CALL_DIRECTION).toBe('clawops.call.direction');
    expect(ATTR_CALL_STATUS).toBe('clawops.call.status');
  });

  it('LLM attributes exist', () => {
    expect(ATTR_LLM_PROVIDER).toBe('clawops.llm.provider');
    expect(ATTR_LLM_MODEL).toBe('clawops.llm.model');
    expect(ATTR_LLM_PROMPT_TOKENS).toBe('clawops.llm.prompt_tokens');
    expect(ATTR_LLM_COMPLETION_TOKENS).toBe('clawops.llm.completion_tokens');
    expect(ATTR_LLM_TOTAL_TOKENS).toBe('clawops.llm.total_tokens');
  });

  it('MCP attributes exist', () => {
    expect(ATTR_MCP_SERVER_TYPE).toBe('clawops.mcp.server_type');
    expect(ATTR_MCP_SERVER_NAME).toBe('clawops.mcp.server_name');
  });

  it('Tool attributes exist', () => {
    expect(ATTR_TOOL_NAME).toBe('clawops.tool.name');
    expect(ATTR_TOOL_RESULT).toBe('clawops.tool.result');
    expect(ATTR_TOOL_ERROR).toBe('clawops.tool.error');
  });

  it('startSpan returns no-op span when tracing disabled', async () => {
    // Tracing disabled by default
    const span = await startSpan('test-span', { key: 'value' });
    // No-op span should have methods but do nothing
    expect(span.setAttribute).toBeDefined();
    expect(span.setStatus).toBeDefined();
    expect(span.recordException).toBeDefined();
    expect(span.end).toBeDefined();
    // Should not throw
    span.setAttribute('foo', 'bar');
    span.setStatus({ code: 1 });
    span.end();
  });

  it('withSpan executes function and returns result', async () => {
    const result = await withSpan('test-span', { key: 'value' }, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('setTracingConfig / getTracingConfig / resetTracingConfig work', () => {
    setTracingConfig({ enabled: true, serviceName: 'custom' });
    let config = getTracingConfig();
    expect(config.enabled).toBe(true);
    expect(config.serviceName).toBe('custom');

    resetTracingConfig();
    config = getTracingConfig();
    expect(config.enabled).toBe(false);
    expect(config.serviceName).toBe('clawops-agent');
  });

  it('multiple attribute categories are exported', () => {
    // Agent attributes
    expect(ATTR_AGENT_ID).toBe('clawops.agent.id');
    expect(ATTR_AGENT_SESSION_TYPE).toBe('clawops.agent.session_type');
    // STT/TTS
    expect(ATTR_STT_PROVIDER).toBe('clawops.stt.provider');
    expect(ATTR_TTS_PROVIDER).toBe('clawops.tts.provider');
    // Audio
    expect(ATTR_AUDIO_SAMPLE_RATE).toBe('clawops.audio.sample_rate');
  });
});
