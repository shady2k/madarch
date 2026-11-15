/**
 * After initdb has ended its pid may be another process's: what it left is ended by identity, never by a number a
 * machine may have handed out again.
 */
import { expect, test } from 'bun:test';
import { endInitdbTree, timeoutEndsInitdb } from '../src/adapters/postgres-cluster.js';
import { commandLineArguments, runsOnDataDir } from '../src/adapters/postgres-preparation-record.js';

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

test('a folder is matched by the -D argument, never as a prefix of another folder', () => {
  const dataDir = 'C:\\store\\pgdata';
  const argv = (commandLine: string): string[] => commandLineArguments(commandLine, 'win32');
  expect(runsOnDataDir('postgres.exe', argv(`C:\\tools\\postgres.exe -D ${dataDir} -p 5432`), dataDir, 'win32')).toBe(true);
  expect(runsOnDataDir('postgres.exe', argv(`C:\\tools\\postgres.exe -D ${dataDir}-other -p 5432`), dataDir, 'win32')).toBe(false);
  expect(runsOnDataDir('initdb.exe', argv(`C:\\tools\\initdb.exe -D${dataDir} --auth=trust`), dataDir, 'win32')).toBe(true);
  expect(runsOnDataDir('postgres.exe', argv(`C:\\tools\\postgres.exe --pgdata=${dataDir}`), dataDir, 'win32')).toBe(true);
  // Quoted paths with spaces, and the folders they only begin with.
  const spaced = 'C:\\store with spaces\\pgdata';
  expect(runsOnDataDir('postgres.exe', argv(`C:\\tools\\postgres.exe -D "${spaced}" -p 5432`), spaced, 'win32')).toBe(true);
  expect(runsOnDataDir('postgres.exe', argv(`C:\\tools\\postgres.exe -D "${spaced} other" -p 5432`), spaced, 'win32')).toBe(false);
  // Windows folds case and separators; another program's -D is not ours.
  expect(runsOnDataDir('POSTGRES.EXE', argv('C:\\tools\\postgres.exe -D c:/STORE/PGDATA'), dataDir, 'win32')).toBe(true);
  expect(runsOnDataDir('notepad.exe', argv(`C:\\Windows\\notepad.exe -D ${dataDir}`), dataDir, 'win32')).toBe(false);
  // PostgreSQL reads the last data directory: an earlier -D is not the one it serves.
  expect(runsOnDataDir('postgres.exe', argv(`C:\\tools\\postgres.exe -D ${dataDir} -D C:\\other\\pgdata`), dataDir, 'win32')).toBe(false);
  expect(runsOnDataDir('postgres.exe', argv(`C:\\tools\\postgres.exe -D C:\\other\\pgdata -D ${dataDir}`), dataDir, 'win32')).toBe(true);
  // No explicit -D is no store of ours (its PGDATA is not ours to read).
  expect(runsOnDataDir('postgres.exe', argv('C:\\tools\\postgres.exe -p 5432'), dataDir, 'win32')).toBe(false);
});

test('a timeout after initdb exited signals no pid, only what names the folder', () => {
  const dataDir = '/store/pgdata';
  const killed: { pid: number; tree: boolean }[] = [];
  const groups: number[] = [];
  const listing = [{ pid: 4242, name: 'postgres.exe', commandLine: `C:\\tools\\postgres.exe --boot -D ${dataDir}` }];
  timeoutEndsInitdb(4242, dataDir, true, { platform: 'win32', processes: () => listing, kill: (pid, tree) => killed.push({ pid, tree }) });
  // The id belongs to nobody: only the program naming the folder is ended.
  expect(killed).toEqual([{ pid: 4242, tree: false }]);
  killed.length = 0;
  timeoutEndsInitdb(700, dataDir, true, { platform: 'win32', processes: () => [], kill: (pid, tree) => killed.push({ pid, tree }) });
  expect(killed).toEqual([]);
  timeoutEndsInitdb(800, dataDir, true, { platform: 'linux', killGroup: (group) => groups.push(group) });
  expect(groups).toEqual([800]);
  timeoutEndsInitdb(900, dataDir, false, { platform: 'win32', processes: () => [], kill: (pid, tree) => killed.push({ pid, tree }) });
  expect(killed).toEqual([{ pid: 900, tree: true }]);
});
