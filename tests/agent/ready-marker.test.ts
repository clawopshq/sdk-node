/**
 * The SDK writes the readiness marker — that line disappears from the customer's app.
 *
 * "The container is up" and "calls can be answered" are not the same thing. The stretch between
 * them (heavy imports, model clients warming, the control connection) is exactly the gap a
 * deploy falls into, and **only the SDK knows where it ends**. That is why the customer's app
 * used to have to create the file itself after `connect()`.
 *
 * Three things are pinned here:
 *   1. it appears when ready and is **removed** when stepping down (handover, drain, shutdown)
 *   2. failing to write it does not block startup — but is not silent either
 *   3. `/healthz`, for distroless, reads the same bit
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';

import { writeReadyMarker, removeReadyMarker } from '../../src/agent/deploy-checks.js';
import { startHealthServer } from '../../src/agent/health.js';

const fakeLog = () => {
  const warn = vi.fn();
  return { log: { warn, info: vi.fn(), debug: vi.fn() } as unknown as Logger, warn };
};

const saved = process.env.CLAWOPS_READY_FILE;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAWOPS_READY_FILE;
  else process.env.CLAWOPS_READY_FILE = saved;
});

function markerPath(): string {
  const p = join(mkdtempSync(join(tmpdir(), 'clawops-ready-')), 'ready');
  process.env.CLAWOPS_READY_FILE = p;
  return p;
}

describe('readiness marker', () => {
  it('appears once ready', () => {
    const p = markerPath();
    writeReadyMarker(fakeLog().log);
    expect(existsSync(p)).toBe(true);
  });

  it('records the pid so a stale marker says who left it', () => {
    const p = markerPath();
    writeReadyMarker(fakeLog().log);
    expect(readFileSync(p, 'utf8')).toContain(`pid=${process.pid}`);
  });

  it('is removed when stepping down', () => {
    const p = markerPath();
    writeReadyMarker(fakeLog().log);
    removeReadyMarker();
    expect(existsSync(p)).toBe(false);
  });

  it('removal is idempotent — handover clears it, then the drain clears it again', () => {
    markerPath();
    expect(() => {
      removeReadyMarker();
      removeReadyMarker();
    }).not.toThrow();
  });

  it('an empty value turns it off', () => {
    const p = markerPath();
    process.env.CLAWOPS_READY_FILE = '';
    writeReadyMarker(fakeLog().log);
    expect(existsSync(p)).toBe(false);
  });

  it('an unwritable path does not block startup, and is not silent', () => {
    process.env.CLAWOPS_READY_FILE = '/this/path/cannot/exist/ready';
    const { log, warn } = fakeLog();
    expect(() => writeReadyMarker(log)).not.toThrow();
    // Staying quiet means the probe never passes and nobody knows why.
    expect(warn.mock.calls[0][0]).toContain('readinessProbe');
  });
});

/**
 * Probed with `node:http` rather than `fetch`.
 *
 * `fetch` keeps its connections alive through undici's pool, so the server does not see them
 * close and `server.close()` waits for sockets that nothing will release — on CI that showed up
 * as a 5s test timeout while passing locally. A kubelet probe opens a plain connection per
 * check, so this is also the closer match to what actually happens.
 */
function probe(port: number, path = '/healthz'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      { host: '127.0.0.1', port, path, agent: false, timeout: 3000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error('probe timed out')));
    req.on('error', reject);
  });
}

describe('/healthz', () => {
  it('is 503 before ready and 200 after', async () => {
    let ready = false;
    const server = await startHealthServer(0, () => ready, fakeLog().log);
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probe(port)).toBe(503);
      ready = true;
      expect(await probe(port)).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not gate on the path — a typo in the probe must not stall a deploy', async () => {
    const server = await startHealthServer(0, () => true, fakeLog().log);
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probe(port, '/healthz')).toBe(200);
      expect(await probe(port, '/health')).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
