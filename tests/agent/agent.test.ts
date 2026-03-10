import { describe, it, expect, vi } from 'vitest';
import { ClawOpsAgent } from '../../src/agent/index.js';
import { AgentError } from '../../src/error.js';
import type { FunctionTool } from '../../src/agent/tool.js';

describe('ClawOpsAgent', () => {
  it('initializes with api key and agent id', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      agentId: 'AG123',
    });
    expect(agent).toBeDefined();
  });

  it('registers tools via agent.tool()', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      agentId: 'AG123',
    });
    const tool: FunctionTool = {
      name: 'greet',
      description: 'Says hello',
      parameters: { name: { type: 'string' } },
      required: ['name'],
      handler: async ({ name }) => `Hi ${name}`,
    };
    agent.tool(tool);
  });

  it('registers event handlers via agent.on()', () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      agentId: 'AG123',
    });
    const handler = vi.fn();
    agent.on('call.incoming', handler);
  });

  it('reads credentials from environment variables', () => {
    const origKey = process.env['CLAWOPS_API_KEY'];
    const origAgent = process.env['CLAWOPS_AGENT_ID'];
    process.env['CLAWOPS_API_KEY'] = 'sk_env';
    process.env['CLAWOPS_AGENT_ID'] = 'AG_env';
    try {
      const agent = new ClawOpsAgent();
      expect(agent).toBeDefined();
    } finally {
      if (origKey) process.env['CLAWOPS_API_KEY'] = origKey;
      else delete process.env['CLAWOPS_API_KEY'];
      if (origAgent) process.env['CLAWOPS_AGENT_ID'] = origAgent;
      else delete process.env['CLAWOPS_AGENT_ID'];
    }
  });

  it('throws AgentError on connect when api_key missing', async () => {
    const origKey = process.env['CLAWOPS_API_KEY'];
    delete process.env['CLAWOPS_API_KEY'];
    try {
      const agent = new ClawOpsAgent({ agentId: 'AG123' });
      await expect(agent.connect()).rejects.toThrow(AgentError);
    } finally {
      if (origKey) process.env['CLAWOPS_API_KEY'] = origKey;
    }
  });

  it('throws AgentError on connect when agent_id missing', async () => {
    const origAgent = process.env['CLAWOPS_AGENT_ID'];
    delete process.env['CLAWOPS_AGENT_ID'];
    try {
      const agent = new ClawOpsAgent({ apiKey: 'sk_test' });
      await expect(agent.connect()).rejects.toThrow(AgentError);
    } finally {
      if (origAgent) process.env['CLAWOPS_AGENT_ID'] = origAgent;
    }
  });
});
