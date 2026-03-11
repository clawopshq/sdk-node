import { describe, it, expect } from 'vitest';
import { buildControlWsUrl } from '../../src/agent/control-ws.js';

describe('buildControlWsUrl', () => {
  it('converts HTTPS to WSS', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key123',
      accountId: 'AC123',
    });
    expect(url).toMatch(/^wss:\/\//);
    expect(url).toContain('AC123');
  });

  it('converts HTTP to WS', () => {
    const url = buildControlWsUrl({
      baseUrl: 'http://localhost:8080',
      apiKey: 'key123',
      accountId: 'AC123',
    });
    expect(url).toMatch(/^ws:\/\//);
  });

  it('uses path /v1/accounts/{accountId}/agent/listen', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key123',
      accountId: 'AC123',
    });
    expect(url).toContain('/v1/accounts/AC123/agent/listen');
  });

  it('appends number as query param', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key123',
      accountId: 'AC123',
      number: '07012345678',
    });
    expect(url).toContain('?number=07012345678');
  });

  it('URL-encodes accountId and number', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com',
      apiKey: 'key123',
      accountId: 'account/special',
      number: '+82 10',
    });
    expect(url).toContain('account%2Fspecial');
    expect(url).toContain('%2B82%2010');
  });

  it('strips trailing slash from baseUrl', () => {
    const url = buildControlWsUrl({
      baseUrl: 'https://api.claw-ops.com/',
      apiKey: 'key123',
      accountId: 'AC123',
    });
    expect(url).not.toContain('.com//');
  });
});
