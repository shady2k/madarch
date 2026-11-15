import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopWindowsDaemon, applicationProcessTree } from '../src/product/windows-daemon-stop.js';

test('Windows shutdown captures only this daemon tree and leaves PostgreSQL for fast shutdown', () => {
  expect(applicationProcessTree(10, [
    { pid: 5, parent: 1, name: 'bun.exe' },
    { pid: 10, parent: 5, name: 'madarch.exe' },
    { pid: 11, parent: 10, name: 'madarch.exe' },
    { pid: 12, parent: 11, name: 'madarch.exe' },
    { pid: 13, parent: 10, name: 'postgres.exe' },
    { pid: 14, parent: 13, name: 'postgres.exe' },
    { pid: 15, parent: 12, name: 'agent.exe' },
    { pid: 20, parent: 5, name: 'madarch.exe' },
  ])).toEqual([10, 11, 12, 15]);
});

test('Windows shutdown does not include a recycled parent chain or duplicate cyclic process readings', () => {
  expect(applicationProcessTree(10, [
    { pid: 11, parent: 10, name: 'bun.exe' },
    { pid: 10, parent: 11, name: 'bun.exe' },
    { pid: 12, parent: 10, name: 'POSTGRES.EXE' },
  ])).toEqual([10, 11]);
});

for (const failure of ['pg_ctl', 'postmaster.pid', 'live postmaster', 'none']) {
  test(`Windows shutdown verifies actual store cleanup: ${failure}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'windows-stop-'));
    const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
    mkdirSync(folder, { recursive: true });
    const pidFile = join(folder, 'postmaster.pid');
    writeFileSync(pidFile, '42\n');
    const pgCtl = join(home, 'pg_ctl.exe');
    writeFileSync(pgCtl, '');
    let killed = false;
    let requested = false;
    try {
      expect(stopWindowsDaemon({ pid: 10, home }, {
        processes: () => [{ pid: 10, parent: 1, name: 'madarch.exe' }],
        alive: (pid) => (pid === 10 && !killed) || (pid === 42 && failure === 'live postmaster'),
        kill: () => { killed = true; },
        pgCtl,
        stopStore: (_program, data) => {
          expect(killed).toBe(true);
          expect(data).toBe(folder);
          requested = true;
          if (failure === 'none' || failure === 'live postmaster') rmSync(pidFile);
          return failure !== 'pg_ctl';
        },
      })).toBe(failure === 'none');
      expect(requested).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 10_000);
}

test('Windows retry sweeps stores without reading or signaling a stale root PID', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-stale-'));
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, {
      storesOnly: true,
      processes: () => { throw new Error('must not inspect a stale process tree'); },
      kill: () => { throw new Error('must not signal a recycled PID'); },
    })).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Windows shutdown terminates initdb bootstrap descendants but keeps running stores for pg_ctl', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-initdb-'));
  const snapshot = [
    { pid: 10, parent: 1, name: 'madarch.exe' },
    { pid: 11, parent: 10, name: 'initdb.exe' },
    { pid: 12, parent: 11, name: 'INITDB.EXE' },
    { pid: 13, parent: 12, name: 'cmd.exe' },
    { pid: 14, parent: 13, name: 'postgres.exe' },
    { pid: 15, parent: 14, name: 'conhost.exe' },
    { pid: 20, parent: 10, name: 'postgres.exe' },
    { pid: 21, parent: 20, name: 'postgres.exe' },
    { pid: 30, parent: 1, name: 'initdb.exe' },
  ];
  const live = new Set(snapshot.map((row) => row.pid));
  const killed: number[] = [];
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, {
      processes: () => snapshot,
      alive: (pid) => live.has(pid),
      kill: (pid) => { killed.push(pid); live.delete(pid); },
    })).toBe(true);
    // Children before parents, so a killed parent's id is never waited on after Windows has recycled it.
    expect(killed).toEqual([15, 14, 13, 12, 11, 10]);
    expect([...live]).toEqual([20, 21, 30]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Windows shutdown continues cleanup when a captured child exits during termination', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-race-'));
  const live = new Set([10, 11, 12]);
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, {
      processes: () => [
        { pid: 10, parent: 1, name: 'madarch.exe' },
        { pid: 11, parent: 10, name: 'initdb.exe' },
        { pid: 12, parent: 11, name: 'cmd.exe' },
      ],
      alive: (pid) => live.has(pid),
      kill: (pid) => {
        live.delete(pid);
        if (pid === 11) throw Object.assign(new Error('already ended'), { code: 'EPERM' });
      },
    })).toBe(true);
    expect([...live]).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Windows shutdown sweeps stores and remaining children even when one application cannot be terminated', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-denied-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  const pidFile = join(folder, 'postmaster.pid');
  writeFileSync(pidFile, '42\n');
  const pgCtl = join(home, 'pg_ctl.exe');
  writeFileSync(pgCtl, '');
  const live = new Set([10, 11, 12, 42]);
  const killed: number[] = [];
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, {
      processes: () => [
        { pid: 10, parent: 1, name: 'madarch.exe' },
        { pid: 11, parent: 10, name: 'initdb.exe' },
        { pid: 12, parent: 11, name: 'cmd.exe' },
      ],
      alive: (pid) => live.has(pid),
      kill: (pid) => {
        killed.push(pid);
        if (pid === 11) throw Object.assign(new Error('access denied'), { code: 'EPERM' });
        live.delete(pid);
      },
      pgCtl,
      stopStore: () => { live.delete(42); rmSync(pidFile); return true; },
    })).toBe(false);
    expect(killed).toEqual([12, 11, 10]);
    expect([...live]).toEqual([11]);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10_000);

test('a hung taskkill exhausts the shared budget but does not prevent store cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-timeout-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  const pidFile = join(folder, 'postmaster.pid');
  writeFileSync(pidFile, '42\n');
  const pgCtl = join(home, 'pg_ctl.exe');
  writeFileSync(pgCtl, '');
  let swept = false;
  let timedOut = false;
  const budgets: number[] = [];
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, {
      processes: () => [
        { pid: 10, parent: 1, name: 'madarch.exe' },
        { pid: 11, parent: 10, name: 'initdb.exe' },
      ],
      alive: (pid) => pid === 10 || pid === 11,
      taskkill: (_pid, timeout) => {
        budgets.push(timeout);
        const result = spawnSync(process.execPath, ['-e', 'while (true) {}'], { encoding: 'utf8', timeout });
        timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
        return result;
      },
      pgCtl,
      stopStore: () => { swept = true; rmSync(pidFile); return true; },
    })).toBe(false);
    expect(timedOut).toBe(true);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeGreaterThan(0);
    expect(budgets[0]).toBeLessThanOrEqual(5_000);
    expect(swept).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15_000);

test('a store listing that fails before the kill does not cancel the stop, and the look after it decides', () => {
  // A store being prepared beside the home can hold its folder as it makes it, and Windows refuses the listing then
  // (madarch-64o5.81). The look before the kill is an optimisation: the tree still ends, and the look after it, with
  // the writers gone, sees the store and sweeps it.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-listing-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  const pidFile = join(folder, 'postmaster.pid');
  writeFileSync(pidFile, '42\n');
  const pgCtl = join(home, 'pg_ctl.exe');
  writeFileSync(pgCtl, '');
  const live = new Set([10, 42]);
  const killed: number[] = [];
  let looks = 0;
  let swept = '';
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, {
      processes: () => [{ pid: 10, parent: 1, name: 'madarch.exe' }],
      alive: (pid) => live.has(pid),
      kill: (pid) => { killed.push(pid); live.delete(pid); },
      storeFolders: () => { looks += 1; return looks === 1 ? new Error('EBUSY: resource busy or locked') : [folder]; },
      pgCtl,
      stopStore: (_program, data) => { swept = data; live.delete(42); rmSync(pidFile); return true; },
    })).toBe(true);
    expect(killed).toEqual([10]);
    expect(swept).toBe(folder);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a knowledge root that cannot be listed at all fails the stop after the tree is gone', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-nolisting-'));
  const live = new Set([10]);
  const killed: number[] = [];
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, {
      processes: () => [{ pid: 10, parent: 1, name: 'madarch.exe' }],
      alive: (pid) => live.has(pid),
      kill: (pid) => { killed.push(pid); live.delete(pid); },
      storeFolders: () => new Error('EPERM: operation not permitted'),
    })).toBe(false);
    // The tree ended even though nothing could say what stores the home holds: a stop never leaves a server running.
    expect(killed).toEqual([10]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function captureErrors(run: () => boolean): { answer: boolean; messages: string[] } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map((value) => String(value)).join(' ')); };
  try { return { answer: run(), messages }; } finally { console.error = original; }
}

test('a final store listing that fails after the tree is gone fails the stop, naming the folder and the error', () => {
  // A store that opens between the first look and the end of the tree is named only by the look taken after it. A
  // look that is refused there cannot say what the home holds, so the stop must not report success over it — the
  // bug the review found (madarch-64o5.81): the refused look fell back to the folders of the first one and a store
  // that had opened meanwhile stayed running while the stop answered true.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-final-listing-'));
  const root = join(home, '.madarch', 'knowledge');
  const folder = join(root, 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  const pgCtl = join(home, 'pg_ctl.exe');
  writeFileSync(pgCtl, '');
  const live = new Set([10]);
  const killed: number[] = [];
  let looks = 0;
  let lastLookSawTreeGone = false;
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, {
      processes: () => [{ pid: 10, parent: 1, name: 'madarch.exe' }],
      alive: (pid) => live.has(pid),
      kill: (pid) => { killed.push(pid); live.delete(pid); },
      // Windows refuses a listing while a preparing store holds the folder (a sharing violation), which is what the
      // look after the tree is gone meets. The store it would have named is never swept, so its server stays.
      storeFolders: () => {
        looks += 1;
        if (looks === 1) return [];
        lastLookSawTreeGone = !live.has(10);
        return new Error('EBUSY: resource busy or locked');
      },
      pgCtl,
      stopStore: () => { throw new Error('no store was known to sweep'); },
    }));
    expect(run.answer).toBe(false);
    expect(killed).toEqual([10]);
    expect(looks).toBe(2);
    expect(lastLookSawTreeGone).toBe(true);
    const failure = run.messages.find((message) => message.includes(root) && message.includes('EBUSY'));
    expect(failure).toBeDefined();
    expect(failure).toContain('after the process tree ended');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a final store listing that fails still sweeps the stores the first look named', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-final-known-'));
  const root = join(home, '.madarch', 'knowledge');
  const folder = join(root, 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  const pidFile = join(folder, 'postmaster.pid');
  writeFileSync(pidFile, '42\n');
  const pgCtl = join(home, 'pg_ctl.exe');
  writeFileSync(pgCtl, '');
  const live = new Set([10, 42]);
  let looks = 0;
  const swept: string[] = [];
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, {
      processes: () => [{ pid: 10, parent: 1, name: 'madarch.exe' }],
      alive: (pid) => live.has(pid),
      kill: (pid) => { live.delete(pid); },
      storeFolders: () => { looks += 1; return looks === 1 ? [folder] : new Error('EPERM: operation not permitted'); },
      pgCtl,
      stopStore: (_program, data) => { swept.push(data); live.delete(42); rmSync(pidFile); return true; },
    }));
    // The stop fails on the look that could not be taken, but the server it already knew about is still ended.
    expect(run.answer).toBe(false);
    expect(swept).toEqual([folder]);
    expect([...live]).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the walk\'s Windows tree ends whole, bootstrap postgres under initdb and cmd included', () => {
  // The tree the clean install walk printed at main c70335f7 (windows-x64 leg): initdb runs its bootstrap
  // `postgres --boot` through cmd.exe, which a taskkill of initdb alone never reaches. No store server is under initdb,
  // so its whole subtree may be ended at once.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-walk-tree-'));
  const snapshot = [
    { pid: 7464, parent: 8344, name: 'madarch.exe' },
    { pid: 1584, parent: 7464, name: 'madarch.exe' },
    { pid: 1364, parent: 1584, name: 'conhost.exe' },
    { pid: 9904, parent: 1584, name: 'madarch.exe' },
    { pid: 6184, parent: 7464, name: 'initdb.exe' },
    { pid: 7048, parent: 6184, name: 'conhost.exe' },
    { pid: 5216, parent: 6184, name: 'initdb.exe' },
    { pid: 5464, parent: 5216, name: 'cmd.exe' },
    { pid: 6252, parent: 5464, name: 'postgres.exe' },
  ];
  expect(applicationProcessTree(7464, snapshot)).toEqual([7464, 1584, 6184, 1364, 9904, 7048, 5216, 5464, 6252]);
  const live = new Set(snapshot.map((row) => row.pid));
  const killed: { pid: number; subtree: boolean }[] = [];
  try {
    expect(stopWindowsDaemon({ pid: 7464, home }, {
      processes: () => snapshot,
      alive: (pid) => live.has(pid),
      // taskkill ends the named process; /T ends what it started, which is what reaches a bootstrap postgres.
      taskkill: (pid, _timeout, subtree) => {
        killed.push({ pid, subtree });
        if (!subtree) { live.delete(pid); return { status: 0, stdout: '', stderr: '' }; }
        const queue = [pid];
        while (queue.length > 0) {
          const at = queue.pop()!;
          live.delete(at);
          for (const row of snapshot) if (row.parent === at && live.has(row.pid)) queue.push(row.pid);
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    })).toBe(true);
    expect([...live]).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
  expect(killed.map((one) => one.pid)).toEqual([6252, 5464, 5216, 7048, 9904, 1364, 6184, 1584, 7464]);
  // initdb's subtree is swept whole; the daemon's is walked, because a store server is under the daemon and only
  // pg_ctl may end it.
  expect(killed.filter((one) => one.subtree).map((one) => one.pid)).toEqual([6252, 5464, 5216, 7048, 6184]);
});

test('a process that outlives its termination fails the stop, and the reason names it', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-survivor-'));
  const live = new Set([10, 11]);
  const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, {
    processes: () => [
      { pid: 10, parent: 1, name: 'madarch.exe' },
      { pid: 11, parent: 10, name: 'stuck.exe' },
    ],
    alive: (pid) => live.has(pid),
    taskkill: (pid) => { if (pid !== 11) live.delete(pid); return { status: 0, stdout: '', stderr: '' }; },
  }));
  try {
    expect(run.answer).toBe(false);
    const why = run.messages.find((message) => message.includes('pid 11 (stuck.exe)'));
    expect(why).toBeDefined();
    expect(why).toContain('running');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10_000);

test('a store server whose pg_ctl is not installed fails the stop, and the reason names the path', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-no-pgctl-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'postmaster.pid'), '42\n');
  const pgCtl = join(home, 'missing', 'pg_ctl.exe');
  const live = new Set([10, 42]);
  const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, {
    processes: () => [{ pid: 10, parent: 1, name: 'madarch.exe' }],
    alive: (pid) => live.has(pid),
    kill: () => { live.delete(10); },
    pgCtl,
    stopStore: () => { throw new Error('no pg_ctl to stop with'); },
  }));
  try {
    expect(run.answer).toBe(false);
    const why = run.messages.find((message) => message.includes(folder) && message.includes(pgCtl));
    expect(why).toBeDefined();
    expect(why).toContain('is not installed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an initdb above the daemon\'s root is not preparation: the daemon is never swept whole', () => {
  // Windows reuses a pid: an unrelated initdb.exe can hold the pid a finished launcher had, so a walk upwards from the
  // daemon finds an initdb above it. The daemon's subtree holds the store server, which only pg_ctl may end, so the
  // preparation walk stops at the root and the daemon is killed by itself.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-reused-'));
  const snapshot = [
    { pid: 40, parent: 1, name: 'initdb.exe' },
    { pid: 100, parent: 40, name: 'madarch.exe' },
    { pid: 90, parent: 100, name: 'postgres.exe' },
    { pid: 91, parent: 100, name: 'madarch.exe' },
  ];
  expect(applicationProcessTree(100, snapshot)).toEqual([100, 91]);
  const live = new Set([90, 91, 100]);
  const killed: { pid: number; subtree: boolean }[] = [];
  const run = captureErrors(() => stopWindowsDaemon({ pid: 100, home }, {
    processes: () => snapshot,
    alive: (pid) => live.has(pid),
    taskkill: (pid, _timeout, subtree) => {
      killed.push({ pid, subtree });
      if (!subtree) live.delete(pid);
      return { status: 0, stdout: '', stderr: '' };
    },
  }));
  try {
    // The store server under the daemon is not in the tree, and nothing of the tree is swept whole.
    expect(run.answer).toBe(true);
    expect(killed.map((one) => one.pid)).toEqual([91, 100]);
    expect(killed.some((one) => one.subtree)).toBe(false);
    expect([...live]).toEqual([90]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the walk\'s second Windows tree ends whole, and a store still being prepared is not swept', () => {
  // The clean install walk at 9027bc2a (windows-x64 leg): the daemon spawns initdb itself, so the tree is
  // madarch.exe 7420 → {madarch.exe 3540 → {conhost, madarch.exe 9800}, initdb.exe 4396 → {conhost, initdb.exe 6296 →
  // cmd.exe → postgres.exe 3420}}. The stop failed with "pg_ctl: cannot stop server; single-user server is running
  // (PID: 9664)" — initdb's bootstrap writes the postmaster.pid pg_ctl reads — so a store being prepared is left to the
  // next open, and the tree, bootstrap included, is what the stop ends.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-walk2-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'postmaster.pid'), '9664\n');
  writeFileSync(join(home, '.madarch', 'knowledge', 'one', 'graph', 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: 4396 } })}\n`);
  const pgCtl = join(home, 'pg_ctl.exe');
  writeFileSync(pgCtl, '');
  const snapshot = [
    { pid: 7420, parent: 5248, name: 'madarch.exe' },
    { pid: 3540, parent: 7420, name: 'madarch.exe' },
    { pid: 4396, parent: 7420, name: 'initdb.exe' },
    { pid: 1220, parent: 3540, name: 'conhost.exe' },
    { pid: 9800, parent: 3540, name: 'madarch.exe' },
    { pid: 2712, parent: 4396, name: 'conhost.exe' },
    { pid: 6296, parent: 4396, name: 'initdb.exe' },
    { pid: 7832, parent: 6296, name: 'cmd.exe' },
    { pid: 3420, parent: 7832, name: 'postgres.exe' },
  ];
  expect(applicationProcessTree(7420, snapshot)).toEqual([7420, 3540, 4396, 1220, 9800, 2712, 6296, 7832, 3420]);
  const live = new Set(snapshot.map((row) => row.pid).concat(9664));
  const killed: { pid: number; subtree: boolean }[] = [];
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, {
      processes: () => snapshot,
      alive: (pid) => live.has(pid),
      taskkill: (pid, _timeout, subtree) => {
        killed.push({ pid, subtree });
        live.delete(pid);
        return { status: 0, stdout: '', stderr: '' };
      },
      pgCtl,
      // pg_ctl refused this store in the walk: preparation must not reach it.
      stopStore: () => { throw new Error('a store being prepared is not swept'); },
      preparationProcesses: () => [],
    }));
    expect(run.answer).toBe(true);
    expect([...live]).toEqual([9664]);
    expect(run.messages.some((message) => message.includes(folder) && message.includes('still being prepared'))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
  expect(killed.map((one) => one.pid)).toEqual([3420, 7832, 6296, 2712, 9800, 1220, 4396, 3540, 7420]);
  expect(killed.filter((one) => one.subtree).map((one) => one.pid)).toEqual([3420, 7832, 6296, 2712, 4396]);
});

test('a preparation left over from a stopped madarch is ended by identity, and a survivor fails the stop', () => {
  // The walk's stop left a store still being prepared while an orphaned bootstrap outside the captured tree kept writing
  // it. Its pid proves nothing after a reuse, so it is ended by the command line that names the folder, and the stop
  // claims success only once nothing names it any more.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-preparing-holders-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(home, '.madarch', 'knowledge', 'one', 'graph', 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: 4396 } })}\n`);
  const snapshot = [{ pid: 7420, parent: 5248, name: 'madarch.exe' }];
  const bootstrap = { pid: 9664, name: 'postgres.exe', commandLine: `C:\\tools\\postgres.exe --boot -D ${folder}` };
  const unrelated = { pid: 9665, name: 'notepad.exe', commandLine: 'C:\\Windows\\notepad.exe' };
  const live = new Set([7420, 9664, 9665]);
  try {
    // The bootstrap is ended; the unrelated process naming nothing of this folder is never signalled.
    const ended = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, {
      processes: () => snapshot,
      alive: (pid) => live.has(pid),
      kill: (pid) => { live.delete(pid); },
      preparationProcesses: () => [bootstrap, unrelated].filter((row) => live.has(row.pid)),
      endProcess: (pid) => { live.delete(pid); },
    }));
    expect(ended.answer).toBe(true);
    expect([...live]).toEqual([9665]);
    expect(ended.messages.join('\n')).toContain('was still being prepared');
    // One that the stop cannot end fails it, and is named.
    const failed = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, {
      processes: () => snapshot,
      alive: (pid) => live.has(pid),
      kill: (pid) => { live.delete(pid); },
      preparationProcesses: () => [bootstrap],
      endProcess: () => { /* the process refuses to go */ },
    }));
    expect(failed.answer).toBe(false);
    expect(failed.messages.join('\n')).toContain('postgres.exe pid 9664');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
