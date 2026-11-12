import { expect, test } from 'bun:test';
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
