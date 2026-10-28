/**
 * A refused handshake (400·401·403) must not be retried.
 *
 * A revoked or expired key, or a number that is no longer this account's, gives the same answer
 * on every attempt. It used to be retried forever on the 1s→30s backoff, indistinguishable from a
 * network blip — measured on the server on 2026-10-28: agents on 21 accounts were sending a 403
 * every 30 seconds, and their owners did not know the agent was dead.
 *
 * 429 and 5xx are different: a reconnect throttle or a gateway being replaced — the slot may
 * genuinely be free, so those keep reconnecting.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { ControlWebSocket } from '../../src/agent/control-ws.js';
import { ClawOpsAgent } from '../../src/agent/agent.js';
import { AgentAuthRejectedError } from '../../src/index.js';
import type { Session } from '../../src/agent/pipeline/base.js';

interface Harness {
  url: string;
  attempts: () => number;
  close: () => Promise<void>;
}

async function startRejectingServer(status: number, code: string | null): Promise<Harness> {
  const server: Server = createServer();
  let attempts = 0;
  server.on('upgrade', (_req, socket) => {
    attempts += 1;
    const body = code ? JSON.stringify({ error: code }) : '';
    socket.end(
      `HTTP/1.1 ${status} Refused\r\n` +
        'Connection: close\r\n' +
        (code ? `X-ClawOps-Error-Code: ${code}\r\n` : '') +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    attempts: () => attempts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ControlWebSocket — refused handshake', () => {
  let harness: Harness | null = null;
  let client: ControlWebSocket | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    await harness?.close();
    harness = null;
  });

  it.each([
    [403, 'api_key_invalid', 'The API key is not valid'],
    [403, 'number_not_owned', 'Number 07012345678 does not belong to account AC1'],
    [401, 'api_key_missing', 'No API key was sent'],
    [400, 'number_missing', 'No number was sent'],
    // An older server without the reason header still stops on the status alone.
    [403, null, 'HTTP 403'],
  ] as const)('%d %s → stops after one attempt', async (status, code, needle) => {
    harness = await startRejectingServer(status, code);
    const rejected: AgentAuthRejectedError[] = [];
    client = new ControlWebSocket({
      baseUrl: harness.url,
      apiKey: 'key',
      accountId: 'AC1',
      number: '07012345678',
      onRejected: (err) => rejected.push(err),
    });

    await client.connect();
    const started = Date.now();
    const err = await client.waitConnected().then(
      () => null,
      (e: unknown) => e,
    );
    // It must settle on the refusal itself — it used to never settle at all.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err).toBeInstanceOf(AgentAuthRejectedError);
    const refusal = err as AgentAuthRejectedError;
    expect(refusal.status).toBe(status);
    expect(refusal.code).toBe(code);
    expect(refusal.message).toContain(needle);

    // Backoff starts at 1s — a retry, if any, lands inside this window.
    await settle(1800);
    expect(harness.attempts()).toBe(1);
    expect(rejected).toEqual([refusal]);
    expect(client.rejected).toBe(refusal);
  });

  it.each([429, 503])('%d → keeps reconnecting', async (status) => {
    harness = await startRejectingServer(status, null);
    const rejected: AgentAuthRejectedError[] = [];
    client = new ControlWebSocket({
      baseUrl: harness.url,
      apiKey: 'key',
      accountId: 'AC1',
      number: '07012345678',
      onRejected: (err) => rejected.push(err),
    });

    await client.connect();
    await settle(1800);
    expect(harness.attempts()).toBeGreaterThanOrEqual(2);
    expect(rejected).toEqual([]);
    expect(client.rejected).toBeNull();
  });
});

function fakeSession(): Session {
  return {
    start: vi.fn(async () => {}),
    attach: vi.fn(async () => {}),
    feedAudio: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as Session;
}

describe('ClawOpsAgent — refused control connection', () => {
  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('connect() throws the refusal itself and nothing keeps retrying behind it', async () => {
    const harness = await startRejectingServer(403, 'api_key_invalid');
    const agent = new ClawOpsAgent({
      apiKey: 'sk_revoked',
      accountId: 'AC1',
      from: '07012345678',
      baseUrl: harness.url,
      session: fakeSession(),
    });
    try {
      const err = await agent.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentAuthRejectedError);
      expect((err as AgentAuthRejectedError).code).toBe('api_key_invalid');
      await settle(1500);
      expect(harness.attempts()).toBe(1);
      // The same agent refuses to try again rather than repeating the refusal against the server.
      await expect(agent.connect()).rejects.toBe(err);
      expect(harness.attempts()).toBe(1);
    } finally {
      await agent.disconnect();
      await harness.close();
    }
  });

  it('a refusal while serving ends serve() with that error after draining', async () => {
    const agent = new ClawOpsAgent({
      apiKey: 'sk_test',
      accountId: 'AC1',
      from: '07012345678',
      session: fakeSession(),
    });
    const drains: Array<{ releaseSlot?: boolean }> = [];
    agent.connect = async () => {};
    agent.drain = async (opts?: { releaseSlot?: boolean }) => {
      drains.push({ releaseSlot: opts?.releaseSlot });
      return { completed: 0, forced: 0 };
    };

    const err = new AgentAuthRejectedError('revoked', { status: 403, code: 'api_key_invalid' });
    setTimeout(
      () => (agent as unknown as { _handleRejected: (e: AgentAuthRejectedError) => void })._handleRejected(err),
      50,
    );

    // No 20-second handover wait for a refused slot — the default test timeout would catch it.
    await expect(agent.serve()).rejects.toBe(err);
    expect(drains).toEqual([{ releaseSlot: true }]);
  });
});
