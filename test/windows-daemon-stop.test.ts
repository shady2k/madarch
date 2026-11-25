import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endWindowsProcesses, listWindowsProcesses, parseWindowsProcessRows } from '../src/adapters/windows-processes.js';
import {
  stopWindowsDaemon,
  applicationProcessTree,
  type WindowsEndResult,
  type WindowsProcess,
} from '../src/product/windows-daemon-stop.js';

const ROOT_CMD = 'madarch.exe daemon-serve C:\\home --port 4180';

function row(
  pid: number,
  parent: number,
  name: string,
  created = 1_700_000_000_000_000 + pid * 10_000,
  commandLine = name,
): WindowsProcess {
  return { pid, parent, name, commandLine, created };
}

function fakeWindowsMachine(
  initial: readonly WindowsProcess[],
  options: {
    stuck?: readonly number[];
    exitedBeforeEnd?: readonly number[];
    reuseBeforeEnd?: ReadonlyMap<number, WindowsProcess>;
    afterRound?: (round: number, state: WindowsProcess[]) => WindowsProcess[];
  } = {},
) {
  let live = initial.map((entry) => ({ ...entry }));
  const stuck = new Set(options.stuck ?? []);
  const exitedBeforeEnd = new Set(options.exitedBeforeEnd ?? []);
  let round = 0;
  const endCalls: { pid: number; created: number }[][] = [];
  return {
    endCalls,
    processes: (): WindowsProcess[] => live.map((entry) => ({ ...entry })),
    alive: (pid: number): boolean => live.some((entry) => entry.pid === pid),
    end: (targets: readonly { pid: number; created: number }[]): WindowsEndResult => {
      round += 1;
      endCalls.push(targets.map((target) => ({ ...target })));
      if (exitedBeforeEnd.size > 0) {
        live = live.filter((entry) => !exitedBeforeEnd.has(entry.pid));
        exitedBeforeEnd.clear();
      }
      if (options.reuseBeforeEnd) {
        live = live.map((entry) => {
          const replacement = options.reuseBeforeEnd!.get(entry.pid);
          return replacement ? { ...replacement } : entry;
        });
      }
      const held: number[] = [];
      const left: number[] = [];
      for (const target of targets) {
        const index = live.findIndex((entry) => entry.pid === target.pid && entry.created === target.created);
        if (index === -1) continue;
        held.push(target.pid);
        if (stuck.has(target.pid)) left.push(target.pid);
        else live.splice(index, 1);
      }
      if (options.afterRound) live = options.afterRound(round, live);
      return { held, left, processes: live.map((entry) => ({ ...entry })) };
    },
    livePids: (): number[] => live.map((entry) => entry.pid),
  };
}

function captureErrors(run: () => boolean): { answer: boolean; messages: string[] } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map((value) => String(value)).join(' ')); };
  try { return { answer: run(), messages }; } finally { console.error = original; }
}

test('Windows shutdown captures only this daemon tree and leaves PostgreSQL for fast shutdown', () => {
  expect(applicationProcessTree(10, [
    row(5, 1, 'bun.exe', 100),
    row(10, 5, 'madarch.exe', 200, ROOT_CMD),
    row(11, 10, 'madarch.exe', 210),
    row(12, 11, 'madarch.exe', 220),
    row(13, 10, 'postgres.exe', 230),
    row(14, 13, 'postgres.exe', 240),
    row(15, 12, 'agent.exe', 250),
    row(20, 5, 'madarch.exe', 260),
  ])).toEqual([10, 11, 12, 15]);
});

test('Windows shutdown does not include a recycled parent chain or duplicate cyclic process readings', () => {
  expect(applicationProcessTree(10, [
    row(11, 10, 'bun.exe', 200),
    row(10, 11, 'bun.exe', 100, ROOT_CMD),
    row(12, 10, 'POSTGRES.EXE', 210),
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
    const machine = fakeWindowsMachine([
      row(10, 1, 'madarch.exe', 1_000, ROOT_CMD),
      row(42, 10, 'postgres.exe', 1_100),
    ]);
    let requested = false;
    try {
      expect(stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
        processes: machine.processes,
        end: machine.end,
        alive: (pid) => machine.alive(pid) && (pid !== 42 || failure === 'live postmaster'),
        pgCtl,
        stopStore: (_program, data) => {
          expect(machine.endCalls).toHaveLength(1);
          expect(machine.alive(10)).toBe(false);
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
    expect(stopWindowsDaemon({ pid: 10, home }, 'stores-only', {
      processes: () => { throw new Error('must not inspect a stale process tree'); },
      end: () => { throw new Error('must not signal a recycled PID'); },
    })).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Windows shutdown terminates initdb bootstrap descendants but keeps running stores for pg_ctl', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-initdb-'));
  const snapshot: WindowsProcess[] = [
    row(10, 1, 'madarch.exe', 1_000, ROOT_CMD),
    row(11, 10, 'initdb.exe', 1_100),
    row(12, 11, 'INITDB.EXE', 1_200),
    row(13, 12, 'cmd.exe', 1_300),
    row(14, 13, 'postgres.exe', 1_400),
    row(15, 14, 'conhost.exe', 1_500),
    row(20, 10, 'postgres.exe', 1_600),
    row(21, 20, 'postgres.exe', 1_700),
    row(30, 1, 'initdb.exe', 1_800),
  ];
  const machine = fakeWindowsMachine(snapshot);
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    })).toBe(true);
    expect(machine.endCalls).toHaveLength(1);
    // Children before parents, so a killed parent's id is never waited on after Windows has recycled it.
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([15, 14, 13, 12, 11, 10]);
    expect(machine.livePids()).toEqual([20, 21, 30]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Windows shutdown continues cleanup when a captured child exits during termination', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-race-'));
  const snapshot: WindowsProcess[] = [
    row(10, 1, 'madarch.exe', 1_000, ROOT_CMD),
    row(11, 10, 'initdb.exe', 1_100),
    row(12, 11, 'cmd.exe', 1_200),
  ];
  // Simulate pid 11 exiting before end opens its handle.
  const machine = fakeWindowsMachine(snapshot, { exitedBeforeEnd: [11] });
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    })).toBe(true);
    expect(machine.endCalls).toHaveLength(1);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([12, 11, 10]);
    expect(machine.livePids()).toEqual([]);
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
  const machine = fakeWindowsMachine([
    row(10, 1, 'madarch.exe', 1_000, ROOT_CMD),
    row(11, 10, 'initdb.exe', 1_100),
    row(12, 11, 'cmd.exe', 1_200),
  ], { stuck: [11] });
  let storeLive = true;
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: (pid) => (pid === 42 ? storeLive : machine.alive(pid)),
      pgCtl,
      stopStore: () => {
        storeLive = false;
        rmSync(pidFile);
        return true;
      },
    }));
    expect(run.answer).toBe(false);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([12, 11, 10]);
    expect(machine.livePids()).toEqual([11]);
    expect(storeLive).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10_000);

test('a failed end call fails the stop without preventing store cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-end-fail-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  const pidFile = join(folder, 'postmaster.pid');
  writeFileSync(pidFile, '42\n');
  const pgCtl = join(home, 'pg_ctl.exe');
  writeFileSync(pgCtl, '');
  let swept = false;
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: () => [
        row(10, 1, 'madarch.exe', 1_000, ROOT_CMD),
        row(11, 10, 'initdb.exe', 1_100),
      ],
      end: () => undefined,
      alive: (pid) => pid === 10 || pid === 11,
      pgCtl,
      stopStore: () => { swept = true; rmSync(pidFile); return true; },
    }));
    expect(run.answer).toBe(false);
    expect(swept).toBe(true);
    expect(run.messages.some((message) => message.includes('could not end the process tree of pid 10'))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

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
  const machine = fakeWindowsMachine([row(10, 1, 'madarch.exe', 1_000, ROOT_CMD)]);
  let storeLive = true;
  let looks = 0;
  let swept = '';
  try {
    expect(stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: (pid) => (pid === 42 ? storeLive : machine.alive(pid)),
      storeFolders: () => { looks += 1; return looks === 1 ? new Error('EBUSY: resource busy or locked') : [folder]; },
      pgCtl,
      stopStore: (_program, data) => { swept = data; storeLive = false; rmSync(pidFile); return true; },
    })).toBe(true);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([10]);
    expect(swept).toBe(folder);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a knowledge root that cannot be listed at all fails the stop after the tree is gone', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-nolisting-'));
  const machine = fakeWindowsMachine([row(10, 1, 'madarch.exe', 1_000, ROOT_CMD)]);
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
      storeFolders: () => new Error('EPERM: operation not permitted'),
    }));
    expect(run.answer).toBe(false);
    // The tree ended even though nothing could say what stores the home holds: a stop never leaves a server running.
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([10]);
    expect(machine.livePids()).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

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
  const machine = fakeWindowsMachine([row(10, 1, 'madarch.exe', 1_000, ROOT_CMD)]);
  let looks = 0;
  let lastLookSawTreeGone = false;
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
      // Windows refuses a listing while a preparing store holds the folder (a sharing violation), which is what the
      // look after the tree is gone meets. The store it would have named is never swept, so its server stays.
      storeFolders: () => {
        looks += 1;
        if (looks === 1) return [];
        lastLookSawTreeGone = !machine.alive(10);
        return new Error('EBUSY: resource busy or locked');
      },
      pgCtl,
      stopStore: () => { throw new Error('no store was known to sweep'); },
    }));
    expect(run.answer).toBe(false);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([10]);
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
  const machine = fakeWindowsMachine([row(10, 1, 'madarch.exe', 1_000, ROOT_CMD)]);
  let storeLive = true;
  let looks = 0;
  const swept: string[] = [];
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: (pid) => (pid === 42 ? storeLive : machine.alive(pid)),
      storeFolders: () => { looks += 1; return looks === 1 ? [folder] : new Error('EPERM: operation not permitted'); },
      pgCtl,
      stopStore: (_program, data) => { swept.push(data); storeLive = false; rmSync(pidFile); return true; },
    }));
    // The stop fails on the look that could not be taken, but the server it already knew about is still ended.
    expect(run.answer).toBe(false);
    expect(swept).toEqual([folder]);
    expect(machine.livePids()).toEqual([]);
    expect(storeLive).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the walk\'s Windows tree ends whole, bootstrap postgres under initdb and cmd included', () => {
  // The tree the clean install walk printed at main c70335f7 (windows-x64 leg): initdb runs its bootstrap
  // `postgres --boot` through cmd.exe. No store server is under initdb, so its whole subtree is ended while the
  // daemon's own postgres.exe store servers stay for pg_ctl.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-walk-tree-'));
  const snapshot: WindowsProcess[] = [
    row(7464, 8344, 'madarch.exe', 1_000, ROOT_CMD),
    row(1584, 7464, 'madarch.exe', 1_100),
    row(1364, 1584, 'conhost.exe', 1_200),
    row(9904, 1584, 'madarch.exe', 1_300),
    row(6184, 7464, 'initdb.exe', 1_400),
    row(7048, 6184, 'conhost.exe', 1_500),
    row(5216, 6184, 'initdb.exe', 1_600),
    row(5464, 5216, 'cmd.exe', 1_700),
    row(6252, 5464, 'postgres.exe', 1_800),
  ];
  expect(applicationProcessTree(7464, snapshot)).toEqual([7464, 1584, 6184, 1364, 9904, 7048, 5216, 5464, 6252]);
  const machine = fakeWindowsMachine(snapshot);
  try {
    expect(stopWindowsDaemon({ pid: 7464, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    })).toBe(true);
    expect(machine.livePids()).toEqual([]);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([6252, 5464, 5216, 7048, 9904, 1364, 6184, 1584, 7464]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a process that outlives its termination fails the stop, and the reason names it', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-survivor-'));
  const machine = fakeWindowsMachine([
    row(10, 1, 'madarch.exe', 1_000, ROOT_CMD),
    row(11, 10, 'stuck.exe', 1_100),
  ], { stuck: [11] });
  const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
    processes: machine.processes,
    end: machine.end,
    alive: machine.alive,
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
  const machine = fakeWindowsMachine([row(10, 1, 'madarch.exe', 1_000, ROOT_CMD)]);
  const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
    processes: machine.processes,
    end: machine.end,
    alive: (pid) => (pid === 42 ? true : machine.alive(pid)),
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
  // preparation walk stops at the root and only the daemon's own non-PostgreSQL children are ended.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-reused-'));
  const snapshot: WindowsProcess[] = [
    row(40, 1, 'initdb.exe', 900),
    row(100, 40, 'madarch.exe', 1_000, ROOT_CMD),
    row(90, 100, 'postgres.exe', 1_100),
    row(91, 100, 'madarch.exe', 1_200),
  ];
  expect(applicationProcessTree(100, snapshot)).toEqual([100, 91]);
  const machine = fakeWindowsMachine(snapshot);
  const run = captureErrors(() => stopWindowsDaemon({ pid: 100, home }, (line) => line.includes('daemon-serve'), {
    processes: machine.processes,
    end: machine.end,
    alive: machine.alive,
  }));
  try {
    // The store server under the daemon is not in the tree, and neither it nor the unrelated initdb above it is ended.
    expect(run.answer).toBe(true);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([91, 100]);
    expect(machine.livePids()).toEqual([40, 90]);
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
  const snapshot: WindowsProcess[] = [
    row(7420, 5248, 'madarch.exe', 1_000, ROOT_CMD),
    row(3540, 7420, 'madarch.exe', 1_100),
    row(4396, 7420, 'initdb.exe', 1_200),
    row(1220, 3540, 'conhost.exe', 1_300),
    row(9800, 3540, 'madarch.exe', 1_400),
    row(2712, 4396, 'conhost.exe', 1_500),
    row(6296, 4396, 'initdb.exe', 1_600),
    row(7832, 6296, 'cmd.exe', 1_700),
    row(3420, 7832, 'postgres.exe', 1_800),
  ];
  expect(applicationProcessTree(7420, snapshot)).toEqual([7420, 3540, 4396, 1220, 9800, 2712, 6296, 7832, 3420]);
  const machine = fakeWindowsMachine(snapshot);
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: (pid) => (pid === 9664 ? true : machine.alive(pid)),
      pgCtl,
      // pg_ctl refused this store in the walk: preparation must not reach it.
      stopStore: () => { throw new Error('a store being prepared is not swept'); },
    }));
    expect(run.answer).toBe(true);
    expect(machine.livePids()).toEqual([]);
    expect(run.messages.some((message) => message.includes(folder) && message.includes('still being prepared'))).toBe(true);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([3420, 7832, 6296, 2712, 9800, 1220, 4396, 3540, 7420]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a preparation left over from a stopped madarch is ended by identity, and a survivor fails the stop', () => {
  // The walk's stop left a store still being prepared while an orphaned bootstrap outside the captured tree kept writing
  // it. Its pid proves nothing after a reuse, so it is ended by the command line that names the folder and its verified
  // creation time, and the stop claims success only once nothing names it any more.
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-preparing-holders-'));
  const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(home, '.madarch', 'knowledge', 'one', 'graph', 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: 4396 } })}\n`);
  const rootRow = row(7420, 5248, 'madarch.exe', 1_000, ROOT_CMD);
  const bootstrap = row(9664, 1, 'postgres.exe', 1_500, `C:\\tools\\postgres.exe --boot -D ${folder}`);
  const unrelated = row(9665, 1, 'notepad.exe', 1_500, 'C:\\Windows\\notepad.exe');
  try {
    // The bootstrap is ended; the unrelated process naming nothing of this folder is never signalled.
    const cleanMachine = fakeWindowsMachine([rootRow, bootstrap, unrelated]);
    const ended = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, (line) => line.includes('daemon-serve'), {
      processes: cleanMachine.processes,
      end: cleanMachine.end,
      alive: cleanMachine.alive,
    }));
    expect(ended.answer).toBe(true);
    expect(cleanMachine.livePids()).toEqual([9665]);
    expect(ended.messages.join('\n')).toContain('was still being prepared');

    // One that the stop cannot end fails it, and is named.
    const stuckMachine = fakeWindowsMachine([rootRow, bootstrap], { stuck: [9664] });
    const failed = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, (line) => line.includes('daemon-serve'), {
      processes: stuckMachine.processes,
      end: stuckMachine.end,
      alive: stuckMachine.alive,
    }));
    expect(failed.answer).toBe(false);
    expect(failed.messages.join('\n')).toContain('postgres.exe pid 9664');

    const missingCreated = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, 'stores-only', {
      processes: () => [{ pid: 9664, parent: 1, name: 'postgres.exe', commandLine: bootstrap.commandLine }],
      end: () => { throw new Error('must not end holder without created'); },
    }));
    expect(missingCreated.answer).toBe(false);
    expect(missingCreated.messages.join('\n')).toContain('no creation time');

    const listFailed = captureErrors(() => stopWindowsDaemon({ pid: 7420, home }, 'stores-only', {
      processes: () => undefined,
      end: () => { throw new Error('must not call end when listing fails'); },
    }));
    expect(listFailed.answer).toBe(false);
    expect(listFailed.messages.join('\n')).toContain('could not be read');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- New regression cases ---

test('case 1: exact 11-row CI topology ignores older foreign system processes under reused PID 8104', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-ci-topology-'));
  const t = 1_764_096_000_000_000;
  const rows: WindowsProcess[] = [
    row(2184, 9120, 'cmd.exe', t + 100, `C:\\Windows\\system32\\cmd.exe /d /s /c npx madarch serve --product ${home}\\p`),
    row(2240, 2184, 'node.exe', t + 200),
    row(1892, 2240, 'cmd.exe', t + 300),
    row(8104, 1892, 'node.exe', t + 400),
    row(8116, 8104, 'csrss.exe', t - 5_000_000),
    row(8164, 8104, 'winlogon.exe', t - 4_900_000),
    row(9244, 8104, 'madarch.exe', t + 500),
    row(7240, 8164, 'fontdrvhost.exe', t - 4_800_000),
    row(5312, 8164, 'dwm.exe', t - 4_700_000),
    row(10156, 9244, 'madarch.exe', t + 600),
    row(5100, 10156, 'madarch.exe', t + 700),
  ];
  expect(applicationProcessTree(2184, rows)).toEqual([2184, 2240, 1892, 8104, 9244, 10156, 5100]);
  const machine = fakeWindowsMachine(rows);
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 2184, home }, (line) => line.includes(home), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    }));
    expect(run.answer).toBe(true);
    expect(machine.endCalls).toHaveLength(1);
    const targeted = machine.endCalls[0]!.map((target) => target.pid);
    expect(targeted).toEqual([5100, 10156, 9244, 8104, 1892, 2240, 2184]);
    for (const foreign of [8116, 8164, 7240, 5312]) {
      expect(targeted).not.toContain(foreign);
      expect(machine.livePids()).toContain(foreign);
    }
    expect(machine.livePids()).toEqual([8116, 8164, 7240, 5312]);
    const logged = run.messages.join('\n');
    expect(logged).toContain('pid 8116 (csrss.exe): older than pid 8104');
    expect(logged).toContain('pid 8164 (winlogon.exe): older than pid 8104');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('case 2: same PID reuse under initdb.exe never ends an older unrelated process', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-initdb-reuse-'));
  const t = 1_764_096_000_000_000;
  const rows: WindowsProcess[] = [
    row(10, 1, 'madarch.exe', t, ROOT_CMD),
    row(11, 10, 'initdb.exe', t + 500),
    row(12, 11, 'cmd.exe', t + 600),
    row(99, 11, 'foreign.exe', t + 100), // older than initdb.exe pid 11
    row(100, 99, 'foreign-child.exe', t + 200),
  ];
  const machine = fakeWindowsMachine(rows);
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    }));
    expect(run.answer).toBe(true);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([12, 11, 10]);
    expect(machine.livePids()).toEqual([99, 100]);
    expect(run.messages.join('\n')).toContain('pid 99 (foreign.exe): older than pid 11');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('case 3: creation time boundary treats equal created as child, 1 us older as ignored, and missing created as ignored and named', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-boundary-'));
  const t = 1_764_096_000_000_000;
  const rows: WindowsProcess[] = [
    row(10, 1, 'madarch.exe', t, ROOT_CMD),
    row(11, 10, 'same-tick.exe', t),
    row(12, 10, 'older-by-1us.exe', t - 1),
    { pid: 13, parent: 10, name: 'no-created.exe', commandLine: 'no-created.exe' },
  ];
  const machine = fakeWindowsMachine(rows);
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    }));
    expect(run.answer).toBe(true);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([11, 10]);
    expect(machine.livePids()).toEqual([12, 13]);
    const logged = run.messages.join('\n');
    expect(logged).toContain('pid 12 (older-by-1us.exe): older than pid 10');
    expect(logged).toContain('pid 13 (no-created.exe): missing creation time');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('case 4: root ownership matrix refuses unverified roots without touching stores and sweeps absent dead roots', () => {
  const scenarios: {
    name: string;
    snapshot: WindowsProcess[] | undefined;
    alive: boolean;
    ownsRoot: (line: string) => boolean;
    expectedAnswer: boolean;
    expectSweep: boolean;
    expectedLog?: string;
  }[] = [
    {
      name: 'predicate refuses',
      snapshot: [row(10, 1, 'other.exe', 1_000, 'C:\\other.exe')],
      alive: true,
      ownsRoot: (line) => line.includes('daemon-serve'),
      expectedAnswer: false,
      expectSweep: false,
      expectedLog: 'not owned',
    },
    {
      name: 'empty commandLine',
      snapshot: [row(10, 1, 'madarch.exe', 1_000, '')],
      alive: true,
      ownsRoot: () => true,
      expectedAnswer: false,
      expectSweep: false,
      expectedLog: 'empty command line',
    },
    {
      name: 'missing created',
      snapshot: [{ pid: 10, parent: 1, name: 'madarch.exe', commandLine: ROOT_CMD }],
      alive: true,
      ownsRoot: () => true,
      expectedAnswer: false,
      expectSweep: false,
      expectedLog: 'missing creation time',
    },
    {
      name: 'absent but alive',
      snapshot: [],
      alive: true,
      ownsRoot: () => true,
      expectedAnswer: false,
      expectSweep: false,
      expectedLog: 'could not find live pid 10',
    },
    {
      name: 'listing unreadable',
      snapshot: undefined,
      alive: true,
      ownsRoot: () => true,
      expectedAnswer: false,
      expectSweep: false,
      expectedLog: 'could not read the process list',
    },
    {
      name: 'absent and not alive',
      snapshot: [],
      alive: false,
      ownsRoot: () => true,
      expectedAnswer: true,
      expectSweep: true,
    },
  ];

  for (const scenario of scenarios) {
    const home = mkdtempSync(join(tmpdir(), 'windows-stop-root-matrix-'));
    const folder = join(home, '.madarch', 'knowledge', 'one', 'graph', 'pgdata');
    mkdirSync(folder, { recursive: true });
    const pidFile = join(folder, 'postmaster.pid');
    writeFileSync(pidFile, '42\n');
    const pgCtl = join(home, 'pg_ctl.exe');
    writeFileSync(pgCtl, '');
    let endCalled = false;
    let swept = false;
    try {
      const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, scenario.ownsRoot, {
        processes: () => scenario.snapshot,
        end: () => { endCalled = true; return { held: [], left: [], processes: [] }; },
        alive: (pid) => (pid === 10 ? scenario.alive : false),
        pgCtl,
        stopStore: () => { swept = true; rmSync(pidFile); return true; },
      }));
      expect(run.answer, scenario.name).toBe(scenario.expectedAnswer);
      expect(endCalled, scenario.name).toBe(false);
      expect(swept, scenario.name).toBe(scenario.expectSweep);
      if (scenario.expectedLog) expect(run.messages.join('\n'), scenario.name).toContain(scenario.expectedLog);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('case 5: PID reused between listing and end (same name, newer created) is not ended and not a survivor', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-reused-before-end-'));
  const t = 1_764_096_000_000_000;
  const machine = fakeWindowsMachine([
    row(10, 1, 'madarch.exe', t, ROOT_CMD),
    row(11, 10, 'madarch.exe', t + 100),
  ], {
    reuseBeforeEnd: new Map([[11, row(11, 1, 'madarch.exe', t + 500_000, 'unrelated')]]),
  });
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    }));
    expect(run.answer).toBe(true);
    expect(machine.livePids()).toEqual([11]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('case 6: survivor check matches exact (pid, created) and ignores reused same-name newer created', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-survivor-exact-'));
  const t = 1_764_096_000_000_000;
  try {
    const stuckMachine = fakeWindowsMachine([
      row(10, 1, 'madarch.exe', t, ROOT_CMD),
      row(11, 10, 'stuck.exe', t + 100),
    ], { stuck: [11] });
    const stuckRun = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: stuckMachine.processes,
      end: stuckMachine.end,
      alive: stuckMachine.alive,
    }));
    expect(stuckRun.answer).toBe(false);
    expect(stuckRun.messages.join('\n')).toContain('pid 11 (stuck.exe)');

    const reusedMachine = fakeWindowsMachine([
      row(10, 1, 'madarch.exe', t, ROOT_CMD),
      row(11, 10, 'stuck.exe', t + 100),
    ], {
      reuseBeforeEnd: new Map([[11, row(11, 1, 'stuck.exe', t + 900_000, 'reused')]]),
    });
    const reusedRun = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: reusedMachine.processes,
      end: reusedMachine.end,
      alive: reusedMachine.alive,
    }));
    expect(reusedRun.answer).toBe(true);
    expect(reusedMachine.livePids()).toEqual([11]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('case 7: straggler rounds catch bootstrap children under held initdb, leave daemon postgres.exe, and stop at round 3', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-stragglers-'));
  const t = 1_764_096_000_000_000;
  try {
    const machine = fakeWindowsMachine([
      row(10, 1, 'madarch.exe', t, ROOT_CMD),
      row(11, 10, 'initdb.exe', t + 100),
    ], {
      afterRound: (round, live) => {
        if (round === 1) {
          return [
            ...live,
            row(12, 11, 'cmd.exe', t + 200),
            row(13, 12, 'postgres.exe', t + 300),
            row(20, 10, 'postgres.exe', t + 400),
          ];
        }
        return live;
      },
    });
    const okRun = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    }));
    expect(okRun.answer).toBe(true);
    expect(machine.endCalls).toHaveLength(2);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([11, 10]);
    expect(machine.endCalls[1]!.map((target) => target.pid)).toEqual([13, 12]);
    expect(machine.livePids()).toEqual([20]);

    const runawayMachine = fakeWindowsMachine([
      row(10, 1, 'madarch.exe', t, ROOT_CMD),
      row(11, 10, 'initdb.exe', t + 100),
    ], {
      afterRound: (round, live) => [
        ...live,
        row(100 + round, round === 1 ? 11 : 99 + round, 'cmd.exe', t + 100 + round * 100),
      ],
    });
    const runawayRun = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: runawayMachine.processes,
      end: runawayMachine.end,
      alive: runawayMachine.alive,
    }));
    expect(runawayRun.answer).toBe(false);
    expect(runawayMachine.endCalls).toHaveLength(3);
    expect(runawayRun.messages.join('\n')).toContain('pid 103 (cmd.exe)');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('case 8: parseWindowsProcessRows normalizes Created, missing text fields, and single-object answers', () => {
  expect(parseWindowsProcessRows({
    ProcessId: 42,
    ParentProcessId: 1,
    Name: null,
    CommandLine: undefined,
    Created: 1_764_096_000_123_456,
  })).toEqual([{
    pid: 42,
    parent: 1,
    name: '',
    commandLine: '',
    created: 1_764_096_000_123_456,
  }]);

  expect(parseWindowsProcessRows([
    { ProcessId: 1, ParentProcessId: 0, Name: 'a.exe', CommandLine: 'a' },
    { ProcessId: 2, ParentProcessId: 0, Name: 'b.exe', CommandLine: 'b', Created: null },
    { ProcessId: 3, ParentProcessId: 0, Name: 'c.exe', CommandLine: 'c', Created: '12345' },
    { ProcessId: 4, ParentProcessId: 0, Name: 'd.exe', CommandLine: 'd', Created: 0 },
    { ProcessId: 5, ParentProcessId: 0, Name: 'e.exe', CommandLine: 'e', Created: -10 },
    { ProcessId: 6, ParentProcessId: 0, Name: 'f.exe', CommandLine: 'f', Created: Number.MAX_SAFE_INTEGER + 1 },
  ])).toEqual([
    { pid: 1, parent: 0, name: 'a.exe', commandLine: 'a' },
    { pid: 2, parent: 0, name: 'b.exe', commandLine: 'b' },
    { pid: 3, parent: 0, name: 'c.exe', commandLine: 'c' },
    { pid: 4, parent: 0, name: 'd.exe', commandLine: 'd' },
    { pid: 5, parent: 0, name: 'e.exe', commandLine: 'e' },
    { pid: 6, parent: 0, name: 'f.exe', commandLine: 'f' },
  ]);
});

test('case 9: dead round 1 PIDs are never reused as straggler roots in round 2', () => {
  const home = mkdtempSync(join(tmpdir(), 'windows-stop-round-root-reuse-'));
  const t = 1_764_096_000_000_000;
  const machine = fakeWindowsMachine([
    row(10, 1, 'madarch.exe', t, ROOT_CMD),
    row(11, 10, 'initdb.exe', t + 100),
  ], {
    afterRound: (round, live) => {
      if (round === 1) {
        return [...live, row(12, 11, 'cmd.exe', t + 200)];
      }
      if (round === 2) {
        // Round 1 ended pid 11 and closed its handle; before round 2's snapshot, Windows reuses pid 11 for svchost.exe with children.
        return [
          ...live,
          row(11, 1, 'svchost.exe', t + 500),
          row(900, 11, 'svchost-child.exe', t + 600),
          row(901, 900, 'svchost-grandchild.exe', t + 700),
        ];
      }
      return live;
    },
  });
  try {
    const run = captureErrors(() => stopWindowsDaemon({ pid: 10, home }, (line) => line.includes('daemon-serve'), {
      processes: machine.processes,
      end: machine.end,
      alive: machine.alive,
    }));
    expect(run.answer).toBe(true);
    expect(machine.endCalls).toHaveLength(2);
    expect(machine.endCalls[0]!.map((target) => target.pid)).toEqual([11, 10]);
    expect(machine.endCalls[1]!.map((target) => target.pid)).toEqual([12]);
    expect(machine.livePids()).toEqual([11, 900, 901]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('case 10: endWindowsProcesses retries via pwsh only when powershell did not start, and rejects empty process snapshots', () => {
  const target = [{ pid: 10, created: 1_764_096_000_000_000 }];
  const validRow = { ProcessId: 1, ParentProcessId: 0, Name: 'System', CommandLine: '', Created: 1_764_096_000_000_000 };

  // Timeout after powershell started must return undefined without invoking pwsh.
  const timeoutPrograms: string[] = [];
  const timeoutResult = endWindowsProcesses(target, (program) => {
    timeoutPrograms.push(program);
    return {
      error: Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      status: null,
      signal: 'SIGTERM',
      pid: 1234,
      stdout: '',
      stderr: '',
    };
  });
  expect(timeoutResult).toBeUndefined();
  expect(timeoutPrograms).toEqual(['powershell']);

  // Non-zero exit after powershell started must return undefined without invoking pwsh.
  const exitPrograms: string[] = [];
  const exitResult = endWindowsProcesses(target, (program) => {
    exitPrograms.push(program);
    return { status: 1, pid: 1235, stdout: '', stderr: 'Get-CimInstance failed' };
  });
  expect(exitResult).toBeUndefined();
  expect(exitPrograms).toEqual(['powershell']);

  // Malformed JSON after powershell started must return undefined without invoking pwsh.
  const badJsonPrograms: string[] = [];
  const badJsonResult = endWindowsProcesses(target, (program) => {
    badJsonPrograms.push(program);
    return { status: 0, pid: 1236, stdout: '{broken', stderr: '' };
  });
  expect(badJsonResult).toBeUndefined();
  expect(badJsonPrograms).toEqual(['powershell']);

  // Empty processes snapshot in endWindowsProcesses must return undefined without invoking pwsh.
  const emptyEndPrograms: string[] = [];
  const emptyEndResult = endWindowsProcesses(target, (program) => {
    emptyEndPrograms.push(program);
    return { status: 0, pid: 1237, stdout: JSON.stringify({ held: [], left: [], processes: [] }), stderr: '' };
  });
  expect(emptyEndResult).toBeUndefined();
  expect(emptyEndPrograms).toEqual(['powershell']);

  // Empty processes snapshot for targets=[] and listWindowsProcesses must return undefined.
  expect(endWindowsProcesses([], () => ({ status: 0, pid: 1238, stdout: '[]', stderr: '' }))).toBeUndefined();
  expect(listWindowsProcesses(() => ({ status: 0, pid: 1239, stdout: '[]', stderr: '' }))).toBeUndefined();

  // ENOENT (powershell never started) falls back to pwsh and verifies script uses ErrorActionPreference=Stop and no double quotes.
  const fallbackPrograms: string[] = [];
  const scripts: string[] = [];
  const fallbackResult = endWindowsProcesses(target, (program, args) => {
    fallbackPrograms.push(program);
    scripts.push(args[3]!);
    if (program === 'powershell') {
      return {
        error: Object.assign(new Error('spawnSync powershell ENOENT'), { code: 'ENOENT' }),
        status: null,
        stdout: null,
        stderr: null,
      };
    }
    return {
      status: 0,
      pid: 2234,
      stdout: JSON.stringify({ held: [10], left: [], processes: [validRow] }),
      stderr: '',
    };
  });
  expect(fallbackPrograms).toEqual(['powershell', 'pwsh']);
  expect(scripts[0]).toStartWith("$ErrorActionPreference='Stop'");
  expect(scripts[0]).not.toContain('"');
  expect(fallbackResult).toEqual({
    held: [10],
    left: [],
    processes: [{ pid: 1, parent: 0, name: 'System', commandLine: '', created: 1_764_096_000_000_000 }],
  });
});
