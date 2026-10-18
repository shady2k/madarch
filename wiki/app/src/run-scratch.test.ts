/**
 * The wiki app's own run scratch (madarch-1xq): its `bun test` gets one scratch
 * home and temporary folder, and that folder is gone when the run ends — the
 * same promise the engine's `test/run-scratch.test.ts` checks for the engine,
 * here for the app's own preload. It lives in `src/` because `bun test test/`
 * at the root treats its argument as a filter over every path that contains
 * `test/`: a test file under `wiki/app/test/` would be collected by the root
 * suite and by a shard, and the shard check counts only `test/` in git.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runScratch, RUN_SCRATCH_PREFIX, RUN_SCRATCH_VARIABLE } from '../../../test/run-scratch.js';

const SCRATCH = runScratch();
const APP = new URL('..', import.meta.url).pathname;

/** The value of a variable that must point inside the run's scratch, named in the error when it does not. */
function insideScratch(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`${name} is not set: the app's preload did not point it into the scratch folder ${SCRATCH.folder}`);
  if (value !== SCRATCH.folder && !value.startsWith(SCRATCH.folder + sep)) throw new Error(`${name} is ${value}, not inside the run's scratch folder ${SCRATCH.folder}`);
  return value;
}

describe('the app run scratch the preload makes', () => {
  test('HOME, MADARCH_HOME, TMPDIR and MADARCH_WIKI_CACHE point inside it', () => {
    for (const name of ['HOME', 'MADARCH_HOME', 'TMPDIR', 'MADARCH_WIKI_CACHE']) insideScratch(name, process.env[name]);
    expect(process.env[RUN_SCRATCH_VARIABLE]).toBe(SCRATCH.folder);
    expect(tmpdir()).toBe(join(SCRATCH.folder, 'tmp'));
    expect(SCRATCH.folder.startsWith(join(SCRATCH.realTemporaryFolder, RUN_SCRATCH_PREFIX))).toBe(true);
  });
});

describe('a child run of the app suite', () => {
  test('writes land inside its scratch and the scratch is gone when it ends', () => {
    const bun = Bun.which('bun');
    if (bun === null) throw new Error('bun is not on PATH: the child run of the app scratch fixture cannot start');
    const child = Bun.spawnSync([bun, 'test', './test/fixtures/writes.case.ts'], { cwd: APP, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
    const stdout = child.stdout.toString();
    if (child.exitCode !== 0) throw new Error(`the child run failed (exit ${child.exitCode}):\nstdout:\n${stdout}\nstderr:\n${child.stderr.toString()}`);
    const printed = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const match = /^path: ([a-z]+) (.+)$/.exec(line);
      if (match !== null) printed.set(match[1]!, match[2]!);
    }
    const scratch = printed.get('scratch');
    if (scratch === undefined) throw new Error(`the child run printed no scratch folder: ${stdout}`);
    for (const kind of ['home', 'temporary', 'locked']) {
      const path = printed.get(kind);
      if (path === undefined) throw new Error(`the child run printed no ${kind} path: ${[...printed.keys()].join(', ')}`);
      if (!path.startsWith(scratch + sep)) throw new Error(`the ${kind} path ${path} is not inside the child's scratch folder ${scratch}`);
    }
    // The run removed its scratch, the folder it left unwritable included.
    expect(existsSync(scratch)).toBe(false);
  }, 60_000);
});
