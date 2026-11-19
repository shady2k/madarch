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
 * Content errors use <full input path>:<1-based line>: <reason>. Open errors use
 * <full input path>:no-line: <reason>; argument errors use this script's full path
 * with :no-line: arguments: <reason>. JSON errors use JSON source lines.
 * Source versions are not verified: if they differ, explicit line mapping or separate
 * confirmation through the check map is required; matching line numbers are not proof.
 *
 * Exit codes: 0 nothing lost, 1 a product line lost coverage, 2 bad input (a missing or
 * unreadable file, a malformed record, a map entry without a reason, bad arguments).
 */
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { byCodePoint } from '../src/model/order';

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

function lineAt(value: string, at: string, what: string): number {
  const number = numberAt(value, at, what);
  if (!Number.isSafeInteger(number) || number < 1) throw new InputError(`${at}: ${what} must be a positive safe integer`);
  return number;
}

interface Source { readonly path: string; readonly text: string }
interface Comparison { readonly before: Source; readonly after: Source; readonly allow?: Source }
interface Result { readonly code: number; readonly output: string }

/** A field's value, or bad input when the field is empty. */
function field(line: string, prefix: string, at: string): string {
  const value = line.slice(prefix.length);
  if (value === '') throw new InputError(`${at}: ${prefix.slice(0, -1)} carries no value`);
  return value;
}

function parseLcov(source: Source): Coverage {
  const path = resolve(source.path);
  const lines = source.text.split('\n');
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
      if (!current) throw new InputError(`${at}: end_of_record without an SF record`);
      if (inside(PRODUCT, current.path)) {
        const merged = files.get(current.path) ?? new Map<number, number>();
        for (const [line, count] of current.lines) merged.set(line, Math.max(merged.get(line) ?? 0, count));
        files.set(current.path, merged);
      }
      current = undefined;
      continue;
    }
    if (!current) throw new InputError(`${at}: a line outside a record: "${line}"`);
    if (line.startsWith('DA:')) {
      const parts = line.slice(3).split(',');
      if (parts.length !== 2 && parts.length !== 3) bad(index, `DA takes a line, a count and an optional checksum: "${line}"`);
      const lineNumber = lineAt(parts[0] ?? '', at, 'the DA line');
      const count = numberAt(parts[1] ?? '', at, 'the DA count');
      if (parts.length === 3 && (parts[2] ?? '') === '') bad(index, 'the DA checksum is empty');
      if (current.lines.has(lineNumber)) bad(index, `the record states line ${lineNumber} twice`);
      current.lines.set(lineNumber, count);
      continue;
    }
    if (line.startsWith('FN:')) {
      const parts = line.slice(3).split(',');
      if (parts.length !== 2) bad(index, `FN takes a line and a name: "${line}"`);
      lineAt(parts[0] ?? '', at, 'the FN line');
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
      lineAt(parts[0] ?? '', at, 'the BRDA line');
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

/** Parse JSON and keep value coordinates; JSON.parse decodes each scalar, never locates it. */
function jsonValues(source: Source): { value: unknown; locations: Map<string, number> } {
  const input = source.text;
  const locations = new Map<string, number>();
  let offset = 0;
  let line = 1;
  const fail = (): never => { throw new InputError(`${resolve(source.path)}:${line}: invalid JSON`); };
  const advance = () => { if (input[offset] === '\n') line += 1; offset += 1; };
  const whitespace = () => { while ([' ', '\t', '\r', '\n'].includes(input[offset] ?? '') && offset < input.length) advance(); };
  const string = (): string => {
    const start = offset;
    advance();
    while (offset < input.length) {
      const char = input[offset];
      if (char === '"') {
        advance();
        try { return JSON.parse(input.slice(start, offset)) as string; } catch { return fail(); }
      }
      if ((char?.charCodeAt(0) ?? 0) < 32) fail();
      if (char === '\\') advance();
      advance();
    }
    return fail();
  };
  const value = (path: string): unknown => {
    whitespace();
    locations.set(path, line);
    const char = input[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const object = char === '{';
      const end = object ? '}' : ']';
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const items: unknown[] = [];
      advance(); whitespace();
      if (input[offset] === end) { advance(); return object ? result : items; }
      while (offset < input.length) {
        let key = String(items.length);
        if (object) {
          if (input[offset] !== '"') return fail();
          key = string(); whitespace();
          if (input[offset] !== ':') return fail();
          advance();
        }
        const child = value(`${path}/${key}`);
        if (object) result[key] = child; else items.push(child);
        whitespace();
        if (input[offset] === end) { advance(); return object ? result : items; }
        if (input[offset] !== ',') return fail();
        advance(); whitespace();
      }
      return fail();
    }
    const start = offset;
    while (offset < input.length && ![' ', '\t', '\r', '\n', ',', ']', '}'].includes(input[offset] ?? '')) advance();
    const token = input.slice(start, offset);
    try {
      const scalar: unknown = JSON.parse(token);
      if (scalar === null || typeof scalar === 'number' || typeof scalar === 'boolean') return scalar;
    } catch { /* report the token's source line below */ }
    return fail();
  };
  const parsed = value('');
  whitespace();
  if (offset !== input.length) fail();
  return { value: parsed, locations };
}

function parseAllow(source: Source): Map<string, string> {
  const full = resolve(source.path);
  const { value: parsed, locations } = jsonValues(source);
  const entries = (parsed as { allow?: unknown } | null)?.allow;
  if (!Array.isArray(entries)) throw new InputError(`${full}:${locations.get('/allow') ?? 1}: the map has no "allow" array`);
  const reasons: Map<string, string> = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as Partial<AllowEntry> | null;
    const coordinate = (field?: string) => `${full}:${locations.get(`/allow/${index}${field ? `/${field}` : ''}`) ?? locations.get(`/allow/${index}`) ?? 1}`;
    const at = coordinate();
    if (!entry || typeof entry !== 'object') throw new InputError(`${at}: not an object`);
    if (typeof entry.file !== 'string' || entry.file === '') throw new InputError(`${at}: no file`);
    const file = resolve(ROOT, entry.file);
    if (typeof entry.line !== 'number' || !Number.isSafeInteger(entry.line) || entry.line < 1) throw new InputError(`${at}: ${file}: no positive safe line number`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') throw new InputError(`${coordinate('reason')}: ${file}:${entry.line}: no reason`);
    const key = `${file}:${entry.line}`;
    if (reasons.has(key)) throw new InputError(`${at}: ${file}:${entry.line} is named twice`);
    reasons.set(key, entry.reason);
  }
  return reasons;
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

const SOURCE_NOTICE = 'Source versions are not verified by lcov. Direct comparison is valid only on the same source version; if sources differ, require explicit line mapping or separate confirmation through the check map (exit 0 alone is not proof).';

/** Pure comparison: no filesystem access, process, or console writes. */
export function compareCoverage(input: Comparison): Result {
  try {
    const before = parseLcov(input.before);
    const after = parseLcov(input.after);
    const allowed = input.allow === undefined ? new Map<string, string>() : parseAllow(input.allow);
    let coveredBefore = 0;
    const lost: Loss[] = [];
    let named = 0;
    for (const [file, lines] of before) for (const [line, count] of lines) {
      if (count === 0) continue;
      coveredBefore += 1;
      if ((after.get(file)?.get(line) ?? 0) > 0) continue;
      if (allowed.has(`${file}:${line}`)) named += 1; else lost.push({ file, line });
    }
    lost.sort((left, right) => byCodePoint(left.file, right.file) || left.line - right.line);
    const messages = lost.map(loss => `${loss.file}:${loss.line}: covered before, uncovered now (no reason in the map)`);
    messages.push(SOURCE_NOTICE, `summary: ${before.size} product files, ${coveredBefore} lines covered before, ${lost.length} lost, ${named} allowed by the map.`);
    return { code: lost.length === 0 ? 0 : EXIT_LOST, output: messages.join('\n') };
  } catch (error) {
    return badInput(error);
  }
}

function badInput(error: unknown): Result {
  if (!(error instanceof InputError)) throw error;
  return { code: EXIT_BAD_INPUT, output: `bad input: ${error.message}\nsummary: comparison not finished: bad input.` };
}

function load(path: string): Source {
  const full = resolve(path);
  try { return { path: full, text: readFileSync(full, 'utf8') }; }
  catch { throw new InputError(`${full}:no-line: cannot read file`); }
}

function main(): number {
  let result: Result;
  try {
    let args: ReturnType<typeof argumentsOf>;
    try { args = argumentsOf(process.argv.slice(2)); }
    catch (error) {
      if (!(error instanceof InputError)) throw error;
      throw new InputError(`${resolve(import.meta.path)}:no-line: arguments: ${error.message}`);
    }
    result = compareCoverage({ before: load(args.oldPath), after: load(args.newPath),
      ...(args.allowPath === undefined ? {} : { allow: load(args.allowPath) }) });
  } catch (error) { result = badInput(error); }
  if (result.code === 0) console.log(result.output); else console.error(result.output);
  return result.code;
}

if (import.meta.main) process.exitCode = main();
