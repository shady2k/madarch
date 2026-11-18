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
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSlowList, SLOW_LIST, SLOW_THRESHOLD_SECONDS, testFiles, type SlowList } from './run-tests.js';

export interface Timings {
  readonly source: string;
  readonly kind: 'single-file' | 'shard' | 'base';
  readonly files: Readonly<Record<string, number>>;
  readonly text?: string;
  readonly locations?: Readonly<Record<string, string>>;
}
export const SINGLE_FILE_EVIDENCE = '.github/workflows/single-file-timings.json';

const USAGE = 'usage: bun scripts/check-slow-tests.ts [--measured <folder of shard-*.json manifests>]';

function fail(message: string): never {
  console.error(`${join(process.cwd(), SLOW_LIST)}:1: ${message}`);
  process.exit(2);
}

export interface BaseChanges { readonly revision: string; readonly changedFiles: readonly string[] }

function location(source: string, text: string, path: string): string {
  const offset = text.indexOf(JSON.stringify(path));
  return `${resolve(source)}:${offset < 0 ? 1 : text.slice(0, offset).split('\n').length}`;
}

/** Inventory repair obligations and compare independent single-file evidence. */
export function slowFindings(all: readonly string[], slow: SlowList, timings: Timings, base?: BaseChanges): string[] {
  const findings: string[] = [];
  const listed = new Set(slow.files.map(entry => entry.path));
  const slowText = readFileSync(SLOW_LIST, 'utf8');
  const at = (path: string): string => timings.locations?.[path] ?? location(timings.source, timings.text ?? '', path);
  for (const entry of slow.files) {
    const here = location(SLOW_LIST, slowText, entry.path);
    if (!Number.isFinite(entry.seconds) || entry.seconds <= SLOW_THRESHOLD_SECONDS) findings.push(`${here}: ${entry.path} is listed with ${String(entry.seconds)} s; the slow criterion is more than 30 s`);
    if (!entry.owner || !/^madarch-[a-z0-9]+(?:\.[0-9]+)*$/.test(entry.owner)) findings.push(`${here}: ${entry.path} has no tracked owner task`);
    if (entry.result === 'red' && entry.reason === 'green-slow') findings.push(`${here}: ${entry.path} is red and cannot use reason green-slow`);
    if (entry.result === 'green' && entry.reason !== 'green-slow') findings.push(`${here}: ${entry.path} is green and must use reason green-slow`);
    for (const field of ['defect', 'replacement', 'exit'] as const) if (!entry[field]?.trim()) findings.push(`${here}: ${entry.path} has no ${field} repair evidence`);
    const ms = timings.files[entry.path];
    if (timings.kind === 'single-file' && typeof ms === 'number' && Math.abs(entry.seconds * 1000 - ms) > 100) findings.push(`${at(entry.path)}: ${entry.path} listed time ${entry.seconds}s disagrees with the committed measurement ${ms}ms`);
  }
  if (timings.kind === 'single-file' && base) for (const path of base.changedFiles) {
    if (!Number.isFinite(timings.files[path])) findings.push(`${at(path)}: ${path} changed since ${base.revision} has no single-file evidence`);
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
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    fail(`${path}:1: is not a Bun timings file: version 1 with a files map`);
  }
  const files = (parsed as { files?: unknown }).files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) fail(`${path}:1: carries no files map`);
  return { source: resolve(path), kind, text, files: files as Record<string, number> };
}

/** The union of the shard manifests a CI run uploaded, taking the larger measure of a repeated file. */
export function readShardTimings(folder: string): Timings {
  const names = readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
  if (names.length === 0) fail(`${folder} holds no shard-*.json timing manifest`);
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--measured') {
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
    const revision = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' }).trim();
    const changedFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', revision, '--', ':(glob)test/**/*.test.ts'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    base = { revision, changedFiles };
  }
  const findings = slowFindings(all, slow, timings, base);
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }
  console.log(`slow tests: ${String(slow.files.length)} listed, ${String(Object.keys(timings.files).length)} measured files, no finding`);
}

if (import.meta.main) main();
