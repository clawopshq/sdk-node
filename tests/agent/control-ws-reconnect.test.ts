import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket as WsType } from 'ws';
import { ControlWebSocket, CLOSE_REPLACED, CLOSE_OWNERSHIP_LOST } from '../../src/agent/control-ws.js';
import type { ControlWsOptions } from '../../src/agent/control-ws.js';

/**
 * Reconnection is not a detail here — it decides whether a rolling deploy is seamless or an outage.
 *
 * A control connection is exclusive per number. When the server hands that slot to a newer
 * process and the replaced one reconnects anyway, it evicts the process that just took over,
 * which reconnects and evicts it back. The two trade the slot for as long as they overlap and
 * the server's throttle eventually quarantines the number for minutes. So "did we reconnect?"
 * has to be pinned against a real server closing a real socket, not asserted about in prose.
 *
 * These are the first tests in this suite to stand up an actual WebSocket server. Everything
 * before them checked URL construction, which is why the reconnect behaviour went unverified.
 */

interface Harness {
  url: string;
  /** Sockets the server has accepted, in order. */
  accepted: WsType[];
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  const accepted: WsType[] = [];

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => accepted.push(ws));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of accepted) ws.terminate();
        server.close(() => resolve());
      }),
  };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function connect(harness: Harness, opts: Partial<ControlWsOptions> = {}): ControlWebSocket {
  return new ControlWebSocket({
    baseUrl: harness.url,
    apiKey: 'key',
    accountId: 'AC1',
    number: '07012345678',
    ...opts,
  });
}

describe('ControlWebSocket reconnection policy', () => {
  let harness: Harness | null = null;
  let client: ControlWebSocket | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    await harness?.close();
    harness = null;
  });

  it('does not reconnect after a takeover close (4409)', async () => {
    harness = await startServer();
    const seen: Array<{ code: number; reason: string }> = [];
    client = connect(harness, { onTerminalClose: (info) => seen.push(info) });

    await client.connect();
    await client.waitConnected();
    expect(harness.accepted).toHaveLength(1);

    harness.accepted[0]!.close(CLOSE_REPLACED, 'replaced by new connection');

    // Reconnect backoff starts at 1s — well inside this window if it were going to happen.
    await settle(1800);

    expect(harness.accepted).toHaveLength(1);
    expect(seen).toEqual([{ code: CLOSE_REPLACED, reason: 'replaced by new connection' }]);
  });

  it('does not reconnect after an ownership close (4403)', async () => {
    harness = await startServer();
    const seen: Array<{ code: number; reason: string }> = [];
    client = connect(harness, { onTerminalClose: (info) => seen.push(info) });

    await client.connect();
    await client.waitConnected();
    harness.accepted[0]!.close(CLOSE_OWNERSHIP_LOST, 'number ownership changed');

    await settle(1800);

    expect(harness.accepted).toHaveLength(1);
    expect(seen.map((s) => s.code)).toEqual([CLOSE_OWNERSHIP_LOST]);
  });

  it('still reconnects when the gateway drains (1001) — the slot is ours to keep', async () => {
    harness = await startServer();
    const seen: Array<{ code: number; reason: string }> = [];
    client = connect(harness, { onTerminalClose: (info) => seen.push(info) });

    await client.connect();
    await client.waitConnected();
    harness.accepted[0]!.close(1001, 'gateway draining');

    await settle(1800);

    expect(harness.accepted.length).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual([]);
  });

  it('still reconnects on an abnormal drop (no close frame)', async () => {
    harness = await startServer();
    client = connect(harness);

    await client.connect();
    await client.waitConnected();
    harness.accepted[0]!.terminate();

    await settle(1800);

    expect(harness.accepted.length).toBeGreaterThanOrEqual(2);
  });
});
