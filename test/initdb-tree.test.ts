/**
 * After initdb has ended its pid may be another process's: what it left is ended by identity, never by a number a
 * machine may have handed out again.
 */
import { expect, test } from 'bun:test';
import { endInitdbTree } from '../src/adapters/postgres-cluster.js';

test('an exited initdb\'s pid is never signalled, though what names the folder is ended', () => {
  const dataDir = 'C:\\store\\pgdata';
  const killed: { pid: number; tree: boolean }[] = [];
  const listing = [
    { pid: 4242, name: 'notepad.exe', commandLine: 'C:\\Windows\\notepad.exe' },
    { pid: 77, name: 'postgres.exe', commandLine: `C:\\tools\\postgres.exe --boot -D ${dataDir}` },
    { pid: 78, name: 'postgres.exe', commandLine: 'C:\\tools\\postgres.exe --boot -D C:\\other\\pgdata' },
  ];
  endInitdbTree(4242, dataDir, false, { platform: 'win32', processes: () => listing, kill: (pid, tree) => killed.push({ pid, tree }) });
  // The unrelated process that holds the pid now lives; the two others are untouched by identity.
  expect(killed).toEqual([{ pid: 77, tree: false }]);
});

test('a live initdb is ended with its tree, and a POSIX one by its group only', () => {
  const killed: { pid: number; tree: boolean }[] = [];
  endInitdbTree(700, 'C:\\store\\pgdata', true, { platform: 'win32', processes: () => [], kill: (pid, tree) => killed.push({ pid, tree }) });
  expect(killed).toEqual([{ pid: 700, tree: true }]);
  const groups: number[] = [];
  endInitdbTree(800, '/store/pgdata', false, { platform: 'linux', killGroup: (group) => groups.push(group) });
  expect(groups).toEqual([800]);
});
