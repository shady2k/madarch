#!/usr/bin/env bun
/**
 * Compares two lcov files by product line coverage: a test rewrite keeps every product line
 * the old test set covered, or names the line in an allow map with a reason.
 *
 *   bun scripts/test-coverage-diff.ts <old.lcov> <new.lcov> [--allow <map.json>]
 *
 * lcov is a line format (`SF:`, `DA:` and the rest), so this is a strict line parser: lines
 * are split, never matched with a regular expression, and a line the format does not allow
 * fails the run with the input file and its line number. A loose parser would swallow a
 * broken record and report a lost line as kept, which is the one answer this command exists
 * to prevent.
 *
 * Only records under `src/` are compared; a record for a test file or a helper is ignored.
 * Every `SF:` path is resolved against this checkout, not the current folder, and an `SF:`
 * path outside it is bad input. Failures print the full path and the line.
 *
 * The allow map is JSON: { "allow": [{ "file": "src/x.ts", "line": 42, "reason": "..." }] }.
 * A path may be relative to the checkout or absolute; a reason is required and non-empty.
 *
 * Exit codes: 0 nothing lost, 1 a product line lost coverage, 2 bad input (a missing or
 * unreadable file, a malformed record, a map entry without a reason, bad arguments).
 */
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PRODUCT = join(ROOT, 'src');
const USAGE = 'usage: bun scripts/test-coverage-diff.ts <old.lcov> <new.lcov> [--allow <map.json>]';
const EXIT_LOST = 1;
const EXIT_BAD_INPUT = 2;

class InputError extends Error {}

type FileCoverage = Map<number, number>;
type Coverage = Map<string, FileCoverage>;
interface AllowEntry { readonly file: string; readonly line: number; readonly reason: string }
interface Loss { readonly file: string; readonly line: number }

function inside(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

function isDigits(text: string): boolean {
  if (text === '') return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function numberAt(value: string, at: string, what: string): number {
  if (!isDigits(value)) throw new InputError(`${at}: ${what} is not a non-negative integer: "${value}"`);
  return Number(value);
}

function text(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InputError(`${resolve(path)}: cannot read: ${reason}`);
  }
}

/** A field's value, or bad input when the field is empty. */
function field(line: string, prefix: string, at: string): string {
  const value = line.slice(prefix.length);
  if (value === '') throw new InputError(`${at}: ${prefix.slice(0, -1)} carries no value`);
  return value;
}

function parseLcov(path: string): Coverage {
  const lines = text(path).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const files: Coverage = new Map();
  let current: { path: string; lines: FileCoverage } | undefined;
  const bad = (index: number, message: string): never => {
    throw new InputError(`${path}:${index + 1}: ${message}`);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const at = `${path}:${index + 1}`;
    if (line.startsWith('TN:')) {
      if (current) bad(index, 'TN appears inside a record');
      continue;
    }
    if (line.startsWith('SF:')) {
      if (current) bad(index, 'SF appears before the previous record ended');
      const named = field(line, 'SF:', at);
      const full = resolve(ROOT, named);
      if (!inside(ROOT, full)) bad(index, `the coverage record names a path outside the checkout: ${full}`);
      current = { path: full, lines: new Map() };
      continue;
    }
    if (line === 'end_of_record') {
      if (!current) bad(index, 'end_of_record without an SF record');
      if (inside(PRODUCT, current.path)) files.set(current.path, current.lines);
      current = undefined;
      continue;
    }
    if (!current) bad(index, `a line outside a record: "${line}"`);
    if (line.startsWith('DA:')) {
      const parts = line.slice(3).split(',');
      if (parts.length !== 2 && parts.length !== 3) bad(index, `DA takes a line, a count and an optional checksum: "${line}"`);
      const lineNumber = numberAt(parts[0] ?? '', at, 'the DA line');
      const count = numberAt(parts[1] ?? '', at, 'the DA count');
      if (parts.length === 3 && (parts[2] ?? '') === '') bad(index, 'the DA checksum is empty');
      if (current.lines.has(lineNumber)) bad(index, `the record states line ${lineNumber} twice`);
      current.lines.set(lineNumber, count);
      continue;
    }
    if (line.startsWith('FN:')) {
      const parts = line.slice(3).split(',');
      if (parts.length !== 2) bad(index, `FN takes a line and a name: "${line}"`);
      numberAt(parts[0] ?? '', at, 'the FN line');
      if ((parts[1] ?? '') === '') bad(index, 'the FN name is empty');
      continue;
    }
    if (line.startsWith('FNDA:')) {
      const parts = line.slice(5).split(',');
      if (parts.length !== 2) bad(index, `FNDA takes a count and a name: "${line}"`);
      numberAt(parts[0] ?? '', at, 'the FNDA count');
      if ((parts[1] ?? '') === '') bad(index, 'the FNDA name is empty');
      continue;
    }
    if (line.startsWith('FNF:') || line.startsWith('FNH:') || line.startsWith('LF:') || line.startsWith('LH:') || line.startsWith('BRF:') || line.startsWith('BRH:')) {
      const prefix = line.slice(0, line.indexOf(':') + 1);
      numberAt(line.slice(prefix.length), at, `the ${prefix.slice(0, -1)} value`);
      continue;
    }
    if (line.startsWith('BRDA:')) {
      const parts = line.slice(5).split(',');
      if (parts.length !== 4) bad(index, `BRDA takes a line, a block, a branch and a taken count: "${line}"`);
      numberAt(parts[0] ?? '', at, 'the BRDA line');
      numberAt(parts[1] ?? '', at, 'the BRDA block');
      numberAt(parts[2] ?? '', at, 'the BRDA branch');
      if ((parts[3] ?? '') !== '-') numberAt(parts[3] ?? '', at, 'the BRDA taken count');
      continue;
    }
    bad(index, `not an lcov line: "${line}"`);
  }
  if (current) throw new InputError(`${path}:${lines.length}: the record has no end_of_record`);
  return files;
}

function parseAllow(path: string): Map<string, string> {
  const full = resolve(ROOT, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(full));
  } catch (error) {
    if (error instanceof InputError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new InputError(`${full}: not JSON: ${reason}`);
  }
  const entries = (parsed as { allow?: unknown } | null)?.allow;
  if (!Array.isArray(entries)) throw new InputError(`${full}: the map has no "allow" array`);
  const reasons: Map<string, string> = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as Partial<AllowEntry> | null;
    const at = `${full}: allow[${index}]`;
    if (!entry || typeof entry !== 'object') throw new InputError(`${at}: not an object`);
    if (typeof entry.file !== 'string' || entry.file === '') throw new InputError(`${at}: no file`);
    if (typeof entry.line !== 'number' || !Number.isInteger(entry.line) || entry.line < 1) throw new InputError(`${at}: no line number`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') throw new InputError(`${at}: ${entry.file}:${entry.line}: no reason`);
    const file = resolve(ROOT, entry.file);
    const key = `${file}:${entry.line}`;
    if (reasons.has(key)) throw new InputError(`${at}: ${file}:${entry.line} is named twice`);
    reasons.set(key, entry.reason);
  }
  return reasons;
}

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function argumentsOf(argv: readonly string[]): { oldPath: string; newPath: string; allowPath: string | undefined } {
  const positional: string[] = [];
  let allowPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--allow') {
      if (allowPath !== undefined) throw new InputError('--allow is given twice');
      const value = argv[index + 1];
      if (value === undefined) throw new InputError('--allow needs a map path');
      allowPath = value;
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new InputError(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 2) throw new InputError(`expected two lcov files, got ${positional.length}. ${USAGE}`);
  return { oldPath: positional[0] ?? '', newPath: positional[1] ?? '', allowPath };
}

function main(): number {
  try {
    const { oldPath, newPath, allowPath } = argumentsOf(process.argv.slice(2));
    const before = parseLcov(oldPath);
    const after = parseLcov(newPath);
    const allowed = allowPath === undefined ? new Map<string, string>() : parseAllow(allowPath);
    let coveredBefore = 0;
    const lost: Loss[] = [];
    const named: Loss[] = [];
    for (const [file, lines] of before) {
      for (const [line, count] of lines) {
        if (count === 0) continue;
        coveredBefore += 1;
        if ((after.get(file)?.get(line) ?? 0) > 0) continue;
        const reason = allowed.get(`${file}:${line}`);
        if (reason === undefined) lost.push({ file, line });
        else named.push({ file, line });
      }
    }
    lost.sort((left, right) => byCodePoint(left.file, right.file) || left.line - right.line);
    for (const loss of lost) {
      console.error(`${loss.file}:${loss.line}: covered before, uncovered now (no reason in the map)`);
    }
    console.log(`summary: ${before.size} product files, ${coveredBefore} lines covered before, ${lost.length} lost, ${named.length} allowed by the map.`);
    return lost.length === 0 ? 0 : EXIT_LOST;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(`bad input: ${error.message}`);
    console.log('summary: comparison not finished: bad input.');
    return EXIT_BAD_INPUT;
  }
}

process.exitCode = main();
