#!/usr/bin/env bun
/**
 * `bun run test` and `bun run test:slow`: the default run leaves out the files
 * `test/slow-files.json` lists (a test whose single-file run takes more than 30
 * seconds, or one that is red because it waits on a bound of 60 seconds or more),
 * and the slow run takes only those files.
 *
 *   bun scripts/run-tests.ts [--slow] [--dry-run] [--only <path>] [--shard=i/n] [bun test flags]
 *
 * The list is read as JSON and the files are listed from the file system; the
 * runner parses no test source and keeps no second list. Every other argument is
 * forwarded to `bun test` unchanged, so `--shard=i/n` still shards the selected
 * files with bun's own timing balance, and `--timings`/`--update-timings` still
 * write the shard's manifest. `--dry-run` prints the selected paths and runs
 * nothing; `--only <path>` narrows the run to the named file (the proof of a
 * single file, and a local convenience), refusing one the chosen mode leaves out. `MADARCH_SKIP_PERF` needs no handling here: it reaches the test files
 * through the environment, as it always has.
 *
 * A path in the slow list that is not a test file of this tree exits 2: the list
 * names what exists, and a deleted test does not stay silently excluded.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { jsonArrayLocations } from './json-lines.js';

export const SLOW_LIST = join('test', 'slow-files.json');
export const SLOW_THRESHOLD_SECONDS = 30;

export type SlowReason = 'green-slow' | 'waits-timeout' | 'red-defect';

/** One file the blocking run leaves out, with the measure that put it here. */
export interface SlowFile {
  readonly path: string;
  readonly seconds: number;
  readonly reason: SlowReason;
  readonly result?: 'green' | 'red';
  readonly owner?: string;
  readonly defect?: string;
  readonly replacement?: string;
  readonly exit?: string;
}

export interface SlowList {
  readonly version: number;
  readonly measuredOn: string;
  readonly files: readonly SlowFile[];
}

const USAGE = 'usage: bun scripts/run-tests.ts [--slow] [--dry-run] [--only <path>] [--shard=<i>/<n>] [bun test flags]';

/** Every `*.test.ts` under `test/` at any depth, relative and in code point order. */
export function testFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(relative(root, path).split(sep).join('/'));
    }
  };
  visit(join(root, 'test'));
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The slow list, refused when it names a path that is not a test file of this tree. */
export function readSlowList(root: string, all: readonly string[]): SlowList {
  const manifest = resolve(root, SLOW_LIST);
  const fail = (message: string, line = 1): never => {
    console.error(`${manifest}:${line}: ${message}`);
    process.exit(2);
  };
  let source = '';
  let parsed: unknown;
  try {
    source = readFileSync(manifest, 'utf8');
    parsed = JSON.parse(source);
  } catch (error) {
    fail(`cannot read the slow list: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { files?: unknown }).files)) {
    fail('the slow list must be an object with a "files" array');
  }
  const list = parsed as SlowList;
  const lines = jsonArrayLocations(source);
  const known = new Set(all);
  const seen = new Set<string>();
  for (const [index, entry] of list.files.entries()) {
    const line = lines[index]?.entryLine;
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') fail('every slow entry names a "path"', line);
    if (seen.has(entry.path)) fail(`duplicate slow path ${entry.path}`, line);
    seen.add(entry.path);
    if (!known.has(entry.path)) fail(`${entry.path} is in the slow list, but it is not a test file of this tree`, line);
    if (entry.reason !== 'green-slow' && entry.reason !== 'waits-timeout' && entry.reason !== 'red-defect') fail(`${entry.path} names no reason: green-slow, waits-timeout or red-defect`, line);
  }
  return list;
}

/** The files one mode runs: everything but the slow list, or the slow list alone. */
export function selectFiles(all: readonly string[], slow: SlowList, mode: 'default' | 'slow'): string[] {
  const listed = new Set(slow.files.map((entry) => entry.path));
  return all.filter((path) => listed.has(path) === (mode === 'slow'));
}

/** The arguments `bun test` receives: the chosen files, then whatever the caller forwarded. */
export function bunArguments(files: readonly string[], forwarded: readonly string[]): string[] {
  return ['test', ...files.map((path) => `./${path}`), ...forwarded];
}

function main(): void {
  const argv = process.argv.slice(2);
  let mode: 'default' | 'slow' = 'default';
  let dryRun = false;
  const only: string[] = [];
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--slow') mode = 'slow';
    else if (argument === '--dry-run') dryRun = true;
    else if (argument === '--only') {
      const path = argv[index + 1];
      if (path === undefined || path.startsWith('--')) {
        console.error('run-tests: --only names one test file, and none was given');
        process.exit(2);
      }
      only.push(path);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      return;
    } else forwarded.push(argument);
  }

  const root = process.cwd();
  const timingIndex = forwarded.findIndex(argument => argument === '--timings' || argument.startsWith('--timings='));
  const timingArgument = forwarded[timingIndex];
  const timingPath = timingArgument === '--timings' ? forwarded[timingIndex + 1] : timingArgument?.slice('--timings='.length);
  const singleTimings = resolve(root, '.github/workflows/single-file-timings.json');
  const updateSingle = forwarded.includes('--update-timings') && timingPath !== undefined && resolve(root, timingPath) === singleTimings;
  if (updateSingle && only.length !== 1) {
    console.error(`${singleTimings}:1: single-file timings need exactly one --only; run: scripts/plugin-sandbox-cgroup.sh bun run test --only <path> --timings=.github/workflows/single-file-timings.json --update-timings`);
    process.exit(2);
  }
  const all = testFiles(root);
  const slow = readSlowList(root, all);
  let files = selectFiles(all, slow, mode);
  for (const path of only) {
    if (!files.includes(path)) {
      console.error(`${resolve(root, path)}:1: is not chosen by the ${mode} run`);
      process.exit(2);
    }
  }
  if (only.length > 0) files = files.filter((path) => only.includes(path));
  if (dryRun) {
    console.log(files.join('\n'));
    return;
  }
  if (files.length === 0) {
    console.error(`run-tests: the ${mode} run selects no test file; nothing ran`);
    return;
  }
  let measurement: string | undefined;
  let previous: { files?: Record<string, unknown>; [key: string]: unknown } = {};
  const args = [...forwarded];
  if (updateSingle) {
    if (existsSync(singleTimings)) previous = JSON.parse(readFileSync(singleTimings, 'utf8'));
    measurement = mkdtempSync(join(tmpdir(), 'madarch-single-timings-'));
    const target = join(measurement, 'timings.json');
    if (timingArgument === '--timings') args[timingIndex + 1] = target;
    else args[timingIndex] = `--timings=${target}`;
  }
  const result = spawnSync('bun', bunArguments(files, args), { cwd: root, stdio: 'inherit', env: process.env });
  if (measurement !== undefined) {
    try {
      if (result.status === 0) {
        const measured = JSON.parse(readFileSync(join(measurement, 'timings.json'), 'utf8'));
        const path = only[0]!;
        writeFileSync(singleTimings, JSON.stringify({ ...previous, ...measured, files: { ...previous.files, [path]: measured.files[path] } }, null, 2) + '\n');
      }
    } finally {
      rmSync(measurement, { recursive: true, force: true });
    }
  }
  if (result.error !== undefined) {
    console.error(`${import.meta.path}:1: bun test did not start: ${result.error.message}`);
    process.exit(2);
  }
  process.exit(result.status ?? 1);
}

if (import.meta.main) main();
