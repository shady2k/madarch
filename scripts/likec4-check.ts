/**
 * The LikeC4 half of `bun run views:check` (design.md, "Checks"): every
 * workspace folder given must pass the pinned `likec4 validate` (the views
 * capability's likec4 requirement). Each folder is validated as a
 * workspace of its own by the `likec4` binary, asked for its JSON report;
 * it works offline in about a second.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { byCodePoint } from '../src/model/order.js';
import type { ViewCheckError } from './mermaid-check.js';

/** The pinned `likec4` of this repository's dev dependencies. */
export const LIKEC4_BIN = fileURLToPath(new URL('../node_modules/.bin/likec4', import.meta.url));

/** Long enough for a large workspace; validating the reference system takes about a second. */
const TIMEOUT_MS = 120_000;

export interface LikeC4CheckResult {
  /** How many LikeC4 files `likec4 validate` read, over every folder. */
  files: number;
  /** Every problem found, in folder order, then file and line order within a folder; empty only when every folder validated. */
  errors: ViewCheckError[];
}

/** The part of `likec4 validate --json`'s report read here; its lines are 0-based. */
interface Report {
  valid: boolean;
  errors: { message: string; file: string; line: number }[];
  stats: { totalFiles: number };
}

/**
 * Validates every folder under `folders` as one LikeC4 workspace with
 * `likec4` (by default the pinned one). No folder, a folder that cannot be
 * read or holds no LikeC4 file, and a `likec4` that cannot be run or gives
 * no report are errors too: a check that checks nothing does not pass.
 */
export function checkLikeC4Workspaces(folders: readonly string[], likec4: string = LIKEC4_BIN): LikeC4CheckResult {
  const result: LikeC4CheckResult = { files: 0, errors: [] };
  if (folders.length === 0) {
    result.errors.push({ file: '', line: 0, message: 'no folders to check' });
    return result;
  }
  for (const folder of folders) {
    try {
      readdirSync(folder);
    } catch (error) {
      result.errors.push({ file: folder, line: 0, message: `cannot read the folder: ${(error as Error).message}` });
      continue;
    }
    const run = spawnSync(likec4, ['validate', '--json', folder], { encoding: 'utf8', timeout: TIMEOUT_MS });
    if (run.error !== undefined) {
      result.errors.push({ file: folder, line: 0, message: `cannot run likec4 validate: ${run.error.message}` });
      continue;
    }
    let report: Report;
    try {
      report = JSON.parse(run.stdout) as Report;
    } catch {
      result.errors.push({ file: folder, line: 0, message: `likec4 validate exited with ${run.status} without a report: ${run.stderr.trim()}` });
      continue;
    }
    result.files += report.stats.totalFiles;
    if (report.stats.totalFiles === 0) result.errors.push({ file: folder, line: 0, message: 'no LikeC4 files to check' });
    const found = report.errors.map((error) => ({ file: error.file, line: error.line + 1, message: error.message }));
    result.errors.push(...found.sort((a, b) => byCodePoint(a.file, b.file) || a.line - b.line));
    if (found.length === 0 && (run.status !== 0 || !report.valid)) {
      result.errors.push({ file: folder, line: 0, message: `likec4 validate exited with ${run.status} and found the workspace ${report.valid ? 'valid' : 'invalid'}, naming no error` });
    }
  }
  return result;
}
