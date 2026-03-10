import { describe, it, expect } from 'vitest';
import { buildControlWsUrl } from '../../src/agent/control-ws.js';

describe('buildControlWsUrl', () => {
  it('converts HTTPS to WSS', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key123',
      agentId: 'AG123',
    });
    expect(url).toMatch(/^wss:\/\//);
    expect(url).toContain('AG123');
    expect(url).toContain('key123');
  });

  it('converts HTTP to WS', () => {
    const url = buildControlWsUrl({
      baseUrl: 'http://localhost:8080',
      apiKey: 'key123',
      agentId: 'AG123',
    });
    expect(url).toMatch(/^ws:\/\//);
  });

  it('uses default path /v1/agent/control', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key123',
      agentId: 'AG123',
    });
    expect(url).toContain('/v1/agent/control');
  });

  it('uses custom path when provided', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key123',
      agentId: 'AG123',
      path: '/v2/custom/path',
    });
    expect(url).toContain('/v2/custom/path');
    expect(url).not.toContain('/v1/agent/control');
  });

  it('URL-encodes apiKey and agentId', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key with spaces',
      agentId: 'agent/special',
    });
    expect(url).toContain('key%20with%20spaces');
    expect(url).toContain('agent%2Fspecial');
  });

  it('strips trailing slash from baseUrl', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com/',
      apiKey: 'key123',
      agentId: 'AG123',
    });
    expect(url).not.toContain('.com//');
  });
});
