#!/usr/bin/env bun
/**
 * `bun run check:slow-tests`: the slow list cannot grow silently, and a slow test
 * cannot hide outside it.
 *
 *   bun scripts/check-slow-tests.ts                        the committed timing baseline
 *   bun scripts/check-slow-tests.ts --measured <folder>    the timing manifests a CI run wrote
 *
 * The check reads `test/slow-files.json`, lists the test files from the file
 * system, and reads measured durations from JSON: by default
 * `.github/workflows/single-file-timings.json`, independently measured single-file
 * runs, and in CI the `shard-*.json` manifests the shard jobs upload. A measured
 * file over 30 seconds that the slow list does not carry is named with its
 * measure and fails the check; so does a listed file whose own measure is not
 * over 30 seconds. Red entries carry concrete repair obligations. A shard's
 * elapsed time is contextual, so only independent single-file evidence is
 * compared with the list's seconds. Changed files since the git merge base
 * must have single-file evidence; new slow measurements must be listed.
 *
 * The command exits 1 with every finding printed, 0 when there is none, and 2
 * when an input cannot be read.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonArrayLocations, jsonValueLine } from './json-lines.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { readSlowList, SLOW_LIST, SLOW_THRESHOLD_SECONDS, testFiles, type SlowList } from './run-tests.js';

export interface Timings {
  readonly source: string;
  readonly kind: 'single-file' | 'shard' | 'base';
  readonly files: Readonly<Record<string, number>>;
  readonly text?: string;
  readonly locations?: Readonly<Record<string, string>>;
}
export const SINGLE_FILE_EVIDENCE = '.github/workflows/single-file-timings.json';

const USAGE = 'usage: bun scripts/check-slow-tests.ts [--measured <folder of shard-*.json manifests>] [--growth]';

function fail(message: string, source = import.meta.path): never {
  console.error(`${resolve(source)}:1: ${message}`);
  process.exit(2);
}

export interface BaseChanges { readonly revision: string; readonly changedFiles: readonly string[]; readonly slowPaths?: readonly string[]; readonly evidence?: Readonly<Record<string, number>> }

function location(source: string, text: string, path: string): string {
  return `${resolve(source)}:${jsonValueLine(text, path)}`;
}


export function evidenceCommand(path: string, slow = false): string {
  return `scripts/plugin-sandbox-cgroup.sh bun run test${slow ? ' --slow' : ''} --only ${path} --timings=${SINGLE_FILE_EVIDENCE} --update-timings`;
}

/** No base manifest means every slow entry is growth, including the initial adoption. */
export function growthPaths(slow: SlowList, timings: Timings, base: BaseChanges): string[] {
  const previous = new Set(base.slowPaths ?? []);
  return [...new Set([
    ...slow.files.filter(entry => !previous.has(entry.path)).map(entry => entry.path),
    ...Object.keys(timings.files).filter(path => timings.files[path] !== base.evidence?.[path]),
  ])].sort();
}

/**
 * Growth includes every addition/changed row, but the blocking pass judges speed
 * claims only: green slow entries. Red entries claim defects, not stable elapsed
 * times; nightly summaries judge their outcomes instead of timing bound waits.
 * Initial adoption has no base manifests: 21 green files (~1347 s), not all 282
 * evidence paths. Normal PRs measure only their added/changed green claims.
 * Fresh times are noisy: run again only after <=30000 ms; both runs must be
 * <=30000 ms to contradict a speed claim. Listed seconds are not a fresh-run
 * target. The stable committed-evidence comparison alone keeps 100 ms tolerance.
 */
export function growthMeasurementPaths(slow: SlowList, timings: Timings, base: BaseChanges): string[] {
  const green = new Set(slow.files.filter(entry => entry.result === 'green').map(entry => entry.path));
  return growthPaths(slow, timings, base).filter(path => green.has(path));
}

export function growthFindings(slow: SlowList, measured: Timings, paths: readonly string[], confirmation?: Timings): string[] {
  const findings: string[] = [];
  for (const path of paths) {
    const at = location(measured.source, measured.text ?? '', path);
    const ms = measured.files[path];
    const entry = slow.files.find(entry => entry.path === path);
    if (!Number.isFinite(ms)) findings.push(`${at}: ${path} has no alone-run measurement`);
    else if (entry && ms! <= SLOW_THRESHOLD_SECONDS * 1000 && confirmation) {
      const second = confirmation.files[path];
      if (!Number.isFinite(second)) findings.push(`${location(confirmation.source, confirmation.text ?? '', path)}: ${path} has no confirmation measurement`);
      else if (second! <= SLOW_THRESHOLD_SECONDS * 1000) findings.push(`${at}: ${path} listed time ${entry.seconds}s disagrees: alone runs ${ms}ms and ${second}ms are both at or below 30000ms (not slow)`);
    } else if (!entry && ms! > SLOW_THRESHOLD_SECONDS * 1000) findings.push(`${at}: ${path} took ${ms}ms and is not in ${SLOW_LIST}`);
  }
  return findings;
}

/** Inventory repair obligations and compare independent single-file evidence. */
export function slowFindings(all: readonly string[], slow: SlowList, timings: Timings, base?: BaseChanges, slowText = ''): string[] {
  const findings: string[] = [];
  const listed = new Set(slow.files.map(entry => entry.path));
  const slowLines = jsonArrayLocations(slowText);
  const at = (path: string): string => timings.locations?.[path] ?? location(timings.source, timings.text ?? '', path);
  for (const [index, entry] of slow.files.entries()) {
    const here = `${resolve(SLOW_LIST)}:${slowLines[index]?.entryLine ?? 1}`;
    if (!Number.isFinite(entry.seconds) || entry.seconds <= SLOW_THRESHOLD_SECONDS) findings.push(`${here}: ${entry.path} is listed with ${String(entry.seconds)} s; the slow criterion is more than 30 s`);
    if (!entry.owner || !/^madarch-[a-z0-9]+(?:\.[0-9]+)*$/.test(entry.owner)) findings.push(`${here}: ${entry.path} has no tracked owner task`);
    if (entry.result === 'red' && entry.reason === 'green-slow') findings.push(`${here}: ${entry.path} is red and cannot use reason green-slow`);
    if (entry.result === 'green' && entry.reason !== 'green-slow') findings.push(`${here}: ${entry.path} is green and must use reason green-slow`);
    for (const field of ['defect', 'replacement', 'exit'] as const) if (!entry[field]?.trim()) findings.push(`${here}: ${entry.path} has no ${field} repair evidence`);
    const ms = timings.files[entry.path];
    if (timings.kind === 'single-file' && typeof ms === 'number' && Math.abs(entry.seconds * 1000 - ms) > 100) findings.push(`${at(entry.path)}: ${entry.path} listed time ${entry.seconds}s disagrees with the committed measurement ${ms}ms`);
  }
  if (timings.kind === 'single-file' && base) for (const path of new Set([...base.changedFiles, ...growthPaths(slow, timings, base)])) {
    if (!Number.isFinite(timings.files[path])) {
      findings.push(`${at(path)}: ${path} changed since ${base.revision} has no single-file evidence`);
    }
  }
  const known = new Set(all);
  for (const [path, milliseconds] of Object.entries(timings.files)) {
    if (!known.has(path) || !Number.isFinite(milliseconds)) continue;
    if (milliseconds > SLOW_THRESHOLD_SECONDS * 1000 && !listed.has(path)) findings.push(`${at(path)}: ${path} took ${String(milliseconds)} ms, more than 30 s, and is not in ${SLOW_LIST}`);
  }
  return findings;
}

/** One Bun timings file, whose `files` map carries milliseconds per test file. */
export function readTimings(path: string, kind: Timings['kind']): Timings {
  let text: string;
  let parsed: unknown;
  try {
    text = readFileSync(path, 'utf8');
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`cannot read: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  if (parsed === null || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    fail(`is not a Bun timings file: version 1 with a files map`, path);
  }
  const files = (parsed as { files?: unknown }).files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) fail(`carries no files map`, path);
  return { source: resolve(path), kind, text, files: files as Record<string, number> };
}

/** The union of the shard manifests a CI run uploaded, taking the larger measure of a repeated file. */
export function readShardTimings(folder: string): Timings {
  let names: string[];
  try { names = readdirSync(folder).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { fail(`cannot read shard folder: ${String(error)}`, folder); }
  if (names.length === 0) fail(`holds no shard-*.json timing manifest`, folder);
  const files: Record<string, number> = {};
  const locations: Record<string, string> = {};
  for (const name of names) {
    const manifest = readTimings(join(folder, name), 'shard');
    for (const [path, milliseconds] of Object.entries(manifest.files)) {
      if (typeof milliseconds === 'number' && milliseconds >= (files[path] ?? 0)) {
        files[path] = milliseconds;
        locations[path] = location(manifest.source, manifest.text!, path);
      }
    }
  }
  return { source: resolve(folder), kind: 'shard', files, locations };
}

function main(): void {
  const argv = process.argv.slice(2);
  let measured: string | undefined;
  let measureGrowth = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--growth') measureGrowth = true;
    else if (argument === '--measured') {
      measured = argv[index + 1];
      if (measured === undefined || measured.startsWith('--')) fail('--measured names the folder of shard-*.json manifests, and none was given');
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      return;
    } else fail(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
  }

  const root = process.cwd();
  const all = testFiles(root);
  const slow = readSlowList(root, all);
  const timings = measured === undefined ? readTimings(join(root, SINGLE_FILE_EVIDENCE), 'single-file') : readShardTimings(measured);
  let base: BaseChanges | undefined;
  if (measured === undefined) {
    try {
      const revision = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const changedFiles = execFileSync('git', ['diff', '--no-renames', '--name-only', '--diff-filter=AM', revision, '--', ':(glob)test/**/*.test.ts'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      const baseFile = (path: string): unknown => {
        const found = spawnSync('git', ['cat-file', '-e', `${revision}:${path}`]);
        if (found.status !== 0) return undefined;
        return JSON.parse(execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' }));
      };
      const oldSlow = baseFile(SLOW_LIST) as SlowList | undefined;
      const oldEvidence = baseFile(SINGLE_FILE_EVIDENCE) as { files: Record<string, number> } | undefined;
      base = { revision, changedFiles, slowPaths: oldSlow?.files.map(entry => entry.path) ?? [], evidence: oldEvidence?.files ?? {} };
    } catch (error) { fail(`cannot read git merge base origin/main or its data: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const findings = slowFindings(all, slow, timings, base, readFileSync(SLOW_LIST, 'utf8'));
  if (measureGrowth && base) {
    const paths = growthMeasurementPaths(slow, timings, base).filter(path => all.includes(path));
    console.log(`growth: ${paths.length} green speed claims require alone runs; red claims are judged nightly`);
    const folder = mkdtempSync(join(tmpdir(), 'madarch-growth-'));
    try {
      for (const [index, path] of paths.entries()) {
        const measure = (attempt: number): Timings | undefined => {
          const output = join(folder, `${index}-${attempt}.json`);
          const args = ['bun', 'run', 'test', '--slow', '--only', path, `--timings=${output}`, '--update-timings'];
          const run = spawnSync('scripts/plugin-sandbox-cgroup.sh', args, { stdio: 'inherit' });
          if (run.error || run.status === null || !existsSync(output)) {
            findings.push(`${resolve(path)}:1: alone run ${attempt} produced no timing evidence (${run.error?.message ?? run.status})`);
            return undefined;
          }
          const measured = readTimings(output, 'single-file');
          console.log(`growth measurement: ${path} attempt=${attempt} milliseconds=${measured.files[path]} exit=${run.status}`);
          if (run.status !== 0) findings.push(`${resolve(path)}:1: claimed green alone run ${attempt} exited ${run.status}`);
          return measured;
        };
        const first = measure(1);
        if (!first) continue;
        const ms = first.files[path];
        const confirmation = Number.isFinite(ms) && ms! <= SLOW_THRESHOLD_SECONDS * 1000 ? measure(2) : undefined;
        findings.push(...growthFindings(slow, first, [path], confirmation));
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    if (base) for (const path of new Set([...base.changedFiles, ...growthPaths(slow, timings, base)])) {
      if (!Number.isFinite(timings.files[path])) console.error(`${resolve(SINGLE_FILE_EVIDENCE)}:1: produce evidence: ${evidenceCommand(path, slow.files.some(entry => entry.path === path))}`);
    }
    process.exit(1);
  }
  console.log(`slow tests: ${String(slow.files.length)} listed, ${String(Object.keys(timings.files).length)} measured files, no finding`);
}

if (import.meta.main) main();
