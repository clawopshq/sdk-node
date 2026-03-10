import { describe, it, expect } from 'vitest';
import { AgentError, AgentConnectionError, ClawOpsError } from '../src/error.js';

describe('Agent exceptions', () => {
  it('AgentError is instance of ClawOpsError', () => {
    const err = new AgentError('test');
    expect(err).toBeInstanceOf(ClawOpsError);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.message).toBe('test');
    expect(err.name).toBe('AgentError');
  });

  it('AgentConnectionError is instance of AgentError', () => {
    const err = new AgentConnectionError('ws failed');
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(ClawOpsError);
    expect(err.message).toBe('ws failed');
    expect(err.name).toBe('AgentConnectionError');
  });

  it('AgentConnectionError has a default message', () => {
    const err = new AgentConnectionError();
    expect(err.message).toBe('Agent WebSocket connection failed.');
  });
});
