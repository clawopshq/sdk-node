/**
 * `/healthz` — the second readiness signal, for images where the file marker cannot be probed.
 *
 * The file is the default (`CLAWOPS_READY_FILE`). One case defeats it: **a distroless image,
 * with no `cat` and no `sh`.** Kubernetes' exec probe runs a command inside the container, so
 * with no binary to run there is no probe at all. Then the only option is an HTTP probe, and an
 * HTTP probe needs us to open a port.
 *
 * Deliberately tiny — this is one bit (ready / not ready), not an observability endpoint.
 */

import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';

/** Serve `/healthz`: 200 when ready, 503 otherwise. Resolves once bound. */
export async function startHealthServer(
  port: number,
  isReady: () => boolean,
  log: Logger,
): Promise<Server> {
  const server = createServer((_req, res) => {
    // The path is not checked. There is only one thing here, so a 404 would serve no purpose,
    // and a deploy stalled by a typo in the probe path is worse than answering every path.
    const ready = isReady();
    res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
    res.end(ready ? 'ready' : 'not ready');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const bound = (server.address() as { port: number } | null)?.port ?? port;
  log.info('Health endpoint: http://0.0.0.0:%d/healthz', bound);
  return server;
}
