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
    expect(killed).toEqual([10, 11, 12, 13, 14, 15]);
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
    expect(killed).toEqual([10, 11, 12]);
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
      storeFolders: () => { looks += 1; return looks === 1 ? undefined : [folder]; },
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
      storeFolders: () => undefined,
    })).toBe(false);
    // The tree ended even though nothing could say what stores the home holds: a stop never leaves a server running.
    expect(killed).toEqual([10]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
