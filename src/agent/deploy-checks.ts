/**
 * Diagnostics for the two deployment failures that never show up in the metrics.
 *
 * Neither of these changes behaviour. They warn, and they clear a stale marker.
 *
 * 1. **The stop signal never reaches the process.** `CMD node dist/index.js` written in shell
 *    form (or `npm start`) puts a shell — or npm — at PID 1, and neither forwards SIGTERM to
 *    its child. On a deploy the SDK never hears the stop, keeps accepting new calls for the
 *    whole grace period, and then SIGKILL cuts every one of them mid-conversation.
 *    Measured on the harness (2026-09-09): **26 calls cut, zero delivery failures.** Looking at
 *    the delivery metric alone, nothing appears to be wrong.
 *
 * 2. **A stale readiness marker.** When a container is SIGKILLed the marker file survives. With
 *    `/tmp` on an emptyDir it survives for the life of the pod, so the next process is marked
 *    Ready *before it has connected* and the calls that arrive in between die.
 *
 * Every check here fails quietly — a diagnostic must never block startup.
 */

import { basename } from 'node:path';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Logger } from 'pino';

/** Default readiness marker path — the one the deployment guide prescribes. */
export const DEFAULT_READY_FILE = '/tmp/clawops-ready';

// Path of a stale marker cleared at import time, held until a logger exists to report it.
let staleCleared: string | null = null;

/** The stale marker cleared at import time, returned **once**. */
export function takeStaleClearNotice(): string | null {
  const p = staleCleared;
  staleCleared = null;
  return p;
}

// Meeting one of these in the parent chain means the signal stops there. npm does forward on
// some versions and platforms, but not all — and it adds a layer either way.
const SIGNAL_SWALLOWERS = new Set([
  'sh',
  'bash',
  'dash',
  'ash',
  'ksh',
  'zsh',
  'busybox',
  'npm',
  'npm-cli.js',
  'yarn',
  'pnpm',
  'npx',
]);

// Meeting one of these means the setup is fine — these inits forward signals. Stop looking.
const SIGNAL_FORWARDERS = new Set([
  'tini',
  'dumb-init',
  'docker-init',
  'catatonit',
  's6-svscan',
  's6-supervise',
  'supervisord',
  'runsvdir',
  'runit',
]);

// Created by the container runtime — not an ancestor of our process tree.
const NOT_OUR_TREE = new Set(['pause', 'systemd', 'launchd', 'init']);

const MAX_CHAIN = 12;

function readCmdline(pid: number): string[] {
  const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  return raw.split('\0').filter((part) => part.length > 0);
}

function readPpid(pid: number): number {
  // /proc/<pid>/stat is "pid (comm) state ppid ...", and comm may contain spaces and
  // parentheses. Cut after the *last* ')' — counting fields from the front gets it wrong.
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const tail = text.slice(text.lastIndexOf(')') + 2).split(/\s+/);
  return Number(tail[1]);
}

// argv[0] and argv[1] basenames, both. `CMD ["npm","start"]` was measured as `npm\0start`,
// but depending on shell and version it also shows up as `node\0.../npm-cli.js` — looking at
// only one of the two misses that form.
function names(cmdline: string[]): string[] {
  return cmdline.slice(0, 2).map((arg) => basename(arg));
}

export function inContainer(): boolean {
  // Outside a container we do not look at all. In a local terminal the parent is always a
  // shell, so warning here would be wrong every single time — and then nobody reads the
  // warning on the one occasion it is right.
  if (process.env.KUBERNETES_SERVICE_HOST) return true;
  if (process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI) {
    return true;
  }
  if (existsSync('/.dockerenv')) return true;
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    return ['docker', 'kubepods', 'containerd', 'ecs', 'lxc'].some((m) => cgroup.includes(m));
  } catch {
    return false;
  }
}

/**
 * The three reads the chain walk needs. Injectable so the tests can describe a process tree
 * without a /proc to read — mocking `node:fs` here would also mock the readiness marker.
 */
export interface ProcReader {
  selfPid(): number;
  cmdline(pid: number): string[];
  ppid(pid: number): number;
}

const PROC: ProcReader = {
  selfPid: () => process.pid,
  cmdline: readCmdline,
  ppid: readPpid,
};

/**
 * Name of the ancestor that will swallow the stop signal, or null if none will.
 *
 * Walks up from this process. Looking only at PID 1 misses `shareProcessNamespace: true`,
 * where PID 1 is `/pause` and our container's entrypoint is some other pid.
 */
export function findSignalSwallower(proc: ProcReader = PROC): string | null {
  try {
    const self = proc.selfPid();
    let pid = self;
    for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
      const chainNames = names(proc.cmdline(pid));
      if (chainNames.some((n) => SIGNAL_FORWARDERS.has(n))) return null; // init forwards it
      if (chainNames.some((n) => NOT_OUR_TREE.has(n))) return null; // outside our tree
      if (pid !== self) {
        // Return the name that actually matched. Returning argv[0] would report
        // `node npm-cli.js` as "node is the problem" and send the reader to the wrong place.
        const hit = chainNames.find((n) => SIGNAL_SWALLOWERS.has(n));
        if (hit) return hit;
      }
      const ppid = proc.ppid(pid);
      if (!Number.isFinite(ppid) || ppid <= 0 || ppid === pid) return null;
      pid = ppid;
    }
  } catch {
    return null; // no /proc (macOS) or a different format — stay quiet
  }
  return null;
}

/** Warn once if the stop signal cannot reach this process. Changes nothing. */
export function warnIfSignalsBlocked(
  log: Logger,
  opts: { proc?: ProcReader; container?: boolean } = {},
): void {
  if (!(opts.container ?? inContainer())) return;
  const swallower = findSignalSwallower(opts.proc ?? PROC);
  if (!swallower) return;
  log.warn(
    `Stop signals will not reach this process — an ancestor is '${swallower}'. ` +
      'Shells and npm do not forward SIGTERM to their child. On a deploy this process never ' +
      'hears the stop, keeps accepting new calls for the whole grace period, and then SIGKILL ' +
      'cuts every call in progress (the delivery metric will show nothing wrong). ' +
      'Fix: use exec form in the Dockerfile (CMD ["node", "dist/index.js"]) or put ' +
      'tini/dumb-init in ENTRYPOINT. ' +
      'https://platform.claw-ops.com/docs/sdk/node/agent/deployment',
  );
}

/**
 * Mark this process as able to take calls.
 *
 * **Only the SDK knows this moment.** "The container is up" and "calls can be answered" are not
 * the same thing — the stretch between them (heavy imports, model clients warming, the control
 * connection) is exactly the gap a deploy falls into, and the orchestrator has no way to see
 * its end. That is why the customer's app used to have to create this file itself after
 * `connect()`. Removing that line is the point of this function.
 *
 * The contents carry the pid and start time, so a stale marker says who left it.
 */
export function writeReadyMarker(log: Logger): void {
  const path = process.env.CLAWOPS_READY_FILE ?? DEFAULT_READY_FILE;
  if (!path) return;
  try {
    writeFileSync(path, `pid=${process.pid} since=${Math.floor(Date.now() / 1000)}\n`);
  } catch (err) {
    // A read-only rootfs and friends. Not being able to leave the marker is no reason to refuse
    // to start — but staying quiet means a readinessProbe never passes and nobody knows why.
    log.warn(
      `Could not write the readiness marker (${path}): ${(err as Error).message}. ` +
        'If you use a readinessProbe it will never pass — mount a writable volume ' +
        '(an emptyDir will do) or point CLAWOPS_READY_FILE somewhere writable.',
    );
  }
}

/** Mark this process as no longer taking new calls (handover, drain, shutdown). */
export function removeReadyMarker(): void {
  const path = process.env.CLAWOPS_READY_FILE ?? DEFAULT_READY_FILE;
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone, or unwritable — either way there is nothing to do */
  }
}

/**
 * Remove a readiness marker left behind by a previous process.
 *
 * The timing is the whole point — this has to run *before* the application creates its own
 * marker, i.e. the moment the connection starts. Later than that and it deletes the marker
 * that was just written.
 *
 * `CLAWOPS_READY_FILE` overrides the path; an empty value turns this off.
 */
export function clearStaleReadyMarker(log?: Logger): void {
  const path = process.env.CLAWOPS_READY_FILE ?? DEFAULT_READY_FILE;
  if (!path) return;
  try {
    unlinkSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A read-only rootfs and friends — a diagnostic must never block startup.
    if (code !== 'ENOENT') log?.debug(`Could not clear readiness marker (${path}): ${code}`);
    return;
  }
  // This runs at **import time**, before the application has configured a logger, so a warning
  // here would go nowhere. Keep the fact and report it from connect(), where a logger exists.
  staleCleared = path;
}
