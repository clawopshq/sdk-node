/**
 * Deployment diagnostics — the two failures that never show up in the metrics.
 *
 * The chain walk reads /proc, so the process tree is injected here. The real container check
 * is done separately against actual containers (see the harness README in the clawops repo).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';

import {
  findSignalSwallower,
  warnIfSignalsBlocked,
  clearStaleReadyMarker,
  type ProcReader,
} from '../../src/agent/deploy-checks.js';

// A process chain, pid 1 first. The last entry is us.
function chain(...cmdlines: string[][]): ProcReader {
  return {
    selfPid: () => cmdlines.length,
    cmdline: (pid) => cmdlines[pid - 1],
    ppid: (pid) => pid - 1, // pid 1's parent is 0 — no further
  };
}

function fakeLog() {
  const warn = vi.fn();
  const debug = vi.fn();
  return { log: { warn, debug } as unknown as Logger, warn, debug };
}

describe('signal delivery diagnosis', () => {
  it('exec form is silent — PID 1 is us', () => {
    expect(findSignalSwallower(chain(['node', 'dist/index.js']))).toBeNull();
  });

  it('catches shell-form CMD (PID 1 = /bin/sh)', () => {
    const proc = chain(['/bin/sh', '-c', 'node dist/index.js'], ['node', 'dist/index.js']);
    expect(findSignalSwallower(proc)).toBe('sh');
  });

  it('catches npm start', () => {
    // Measured: /proc/1/cmdline was `npm\0start`.
    const proc = chain(['npm', 'start'], ['node', 'dist/index.js']);
    expect(findSignalSwallower(proc)).toBe('npm');
  });

  it('catches the form where npm looks like node — argv[1] matters', () => {
    const proc = chain(
      ['node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'start'],
      ['node', 'dist/index.js'],
    );
    expect(findSignalSwallower(proc)).toBe('npm-cli.js');
  });

  it('tini is fine', () => {
    expect(findSignalSwallower(chain(['/sbin/tini', '--'], ['node', 'app.js']))).toBeNull();
  });

  it('catches a shell underneath tini — the signal still stops at the shell', () => {
    const proc = chain(['/sbin/tini', '--'], ['/bin/sh', '-c', 'node app.js'], ['node', 'app.js']);
    expect(findSignalSwallower(proc)).toBe('sh');
  });

  it('sees past /pause under shareProcessNamespace', () => {
    // PID 1 is /pause — looking only at PID 1 misses the shell above us entirely.
    const proc = chain(['/pause'], ['/bin/sh', '-c', 'node app.js'], ['node', 'app.js']);
    expect(findSignalSwallower(proc)).toBe('sh');
  });

  it('stays quiet when /proc is unreadable (macOS)', () => {
    const proc: ProcReader = {
      selfPid: () => 1,
      cmdline: () => {
        throw new Error('ENOENT /proc');
      },
      ppid: () => 0,
    };
    expect(findSignalSwallower(proc)).toBeNull();
  });

  it('does not look at all outside a container', () => {
    // A local terminal always has a shell for a parent. Warning here would be wrong every
    // time, and then nobody reads the warning on the one occasion it is right.
    const { log, warn } = fakeLog();
    const proc = chain(['/bin/sh', '-c', 'node app.js'], ['node', 'app.js']);
    warnIfSignalsBlocked(log, { proc, container: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('the warning says how to fix it', () => {
    const { log, warn } = fakeLog();
    const proc = chain(['/bin/sh', '-c', 'node app.js'], ['node', 'app.js']);
    warnIfSignalsBlocked(log, { proc, container: true });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('exec form');
    expect(message).toContain('tini');
  });
});

describe('stale readiness marker', () => {
  const saved = process.env.CLAWOPS_READY_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAWOPS_READY_FILE;
    else process.env.CLAWOPS_READY_FILE = saved;
  });

  it('removes a marker left by a previous process', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'clawops-')), 'ready');
    writeFileSync(marker, '');
    process.env.CLAWOPS_READY_FILE = marker;
    const { log, warn } = fakeLog();
    clearStaleReadyMarker(log);
    expect(existsSync(marker)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is silent when there is nothing to remove', () => {
    process.env.CLAWOPS_READY_FILE = join(mkdtempSync(join(tmpdir(), 'clawops-')), 'nope');
    const { log, warn, debug } = fakeLog();
    clearStaleReadyMarker(log);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('an empty value turns it off', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'clawops-')), 'ready');
    writeFileSync(marker, '');
    process.env.CLAWOPS_READY_FILE = '';
    clearStaleReadyMarker(fakeLog().log);
    expect(existsSync(marker)).toBe(true);
  });

  it('an unremovable path does not block startup', () => {
    process.env.CLAWOPS_READY_FILE = '/this/path/cannot/exist/ready';
    expect(() => clearStaleReadyMarker(fakeLog().log)).not.toThrow();
  });
});
