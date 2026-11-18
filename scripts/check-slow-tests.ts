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
 * `.github/workflows/test-timings.json`, whose numbers come from single-file
 * runs, and in CI the `shard-*.json` manifests the shard jobs upload. A measured
 * file over 30 seconds that the slow list does not carry is named with its
 * measure and fails the check; so does a listed file whose own measure is not
 * over 30 seconds, or a red entry with no owner task. A shard measures a file
 * beside others, so its number is never larger than the file's own run: the CI
 * rule can miss a file just over the line, but it cannot accuse a fast one.
 *
 * The command exits 1 with every finding printed, 0 when there is none, and 2
 * when an input cannot be read.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSlowList, SLOW_LIST, SLOW_THRESHOLD_SECONDS, testFiles, type SlowList } from './run-tests.js';

export interface Timings {
  readonly source: string;
  readonly files: Readonly<Record<string, number>>;
}

const USAGE = 'usage: bun scripts/check-slow-tests.ts [--measured <folder of shard-*.json manifests>]';

function fail(message: string): never {
  console.error(`${SLOW_LIST}:1: ${message}`);
  process.exit(2);
}

/** Every finding, each naming the test file and the measure that produced it. */
export function slowFindings(all: readonly string[], slow: SlowList, timings: Timings): string[] {
  const findings: string[] = [];
  const listed = new Set(slow.files.map((entry) => entry.path));
  for (const entry of slow.files) {
    if (!Number.isFinite(entry.seconds) || entry.seconds <= SLOW_THRESHOLD_SECONDS) {
      findings.push(`${SLOW_LIST}: ${entry.path} is listed with ${String(entry.seconds)} s; the slow criterion is more than ${String(SLOW_THRESHOLD_SECONDS)} s`);
    }
    if (entry.result === 'red' && (entry.owner === undefined || entry.owner.trim() === '')) {
      findings.push(`${SLOW_LIST}: ${entry.path} is red and names no owner task`);
    }
  }
  const known = new Set(all);
  for (const [path, milliseconds] of Object.entries(timings.files)) {
    if (!known.has(path) || !Number.isFinite(milliseconds)) continue;
    if (milliseconds > SLOW_THRESHOLD_SECONDS * 1000 && !listed.has(path)) {
      findings.push(`${timings.source}: ${path} took ${String(milliseconds)} ms, more than ${String(SLOW_THRESHOLD_SECONDS)} s, and is not in ${SLOW_LIST}`);
    }
  }
  return findings;
}

/** One Bun timings file, whose `files` map carries milliseconds per test file. */
export function readTimings(path: string): Timings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    fail(`${path} is not a Bun timings file: version 1 with a files map`);
  }
  const files = (parsed as { files?: unknown }).files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) fail(`${path} carries no files map`);
  return { source: path, files: files as Record<string, number> };
}

/** The union of the shard manifests a CI run uploaded, taking the larger measure of a repeated file. */
export function readShardTimings(folder: string): Timings {
  const names = readdirSync(folder).filter((name) => /^shard-[0-9]+\.json$/.test(name)).sort();
  if (names.length === 0) fail(`${folder} holds no shard-*.json timing manifest`);
  const files: Record<string, number> = {};
  for (const name of names) {
    for (const [path, milliseconds] of Object.entries(readTimings(join(folder, name)).files)) {
      if (typeof milliseconds === 'number') files[path] = Math.max(files[path] ?? 0, milliseconds);
    }
  }
  return { source: folder, files };
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
  const timings = measured === undefined ? readTimings(join(root, '.github', 'workflows', 'test-timings.json')) : readShardTimings(measured);
  const findings = slowFindings(all, slow, timings);
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }
  console.log(`slow tests: ${String(slow.files.length)} listed, ${String(Object.keys(timings.files).length)} measured files, no finding`);
}

if (import.meta.main) main();
