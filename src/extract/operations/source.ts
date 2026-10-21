/**
 * Reading one tree's text: the decoded bytes, the lines, and the spans records
 * point at. Offsets are bytes (records.ts), lines are 1-based; both come from
 * the same decoded text, so a span made here is the span the bytes hold.
 */
import type { SourceSpan, TreeReader } from '../records.js';
import { byCodePoint } from '../../model/order.js';

const encoder = new TextEncoder();

export class TreeText {
  /** The tree's paths, as a set for `has`. */
  readonly has: (path: string) => boolean;

  private readonly texts = new Map<string, string>();
  private readonly linesCache = new Map<string, readonly string[]>();

  readonly tree: TreeReader;

  constructor(tree: TreeReader) {
    this.tree = tree;
    const paths = new Set(tree.paths);
    this.has = (path) => paths.has(path);
  }

  /** The file's text, decoded once. A path the tree does not hold throws. */
  text(path: string): string {
    const held = this.texts.get(path);
    if (held !== undefined) return held;
    const read = new TextDecoder().decode(this.tree.read(path));
    this.texts.set(path, read);
    return read;
  }

  /** The file's lines, split once, without their trailing line feed. */
  lines(path: string): readonly string[] {
    const held = this.linesCache.get(path);
    if (held !== undefined) return held;
    const lines = this.text(path).split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    this.linesCache.set(path, lines);
    return lines;
  }

  /** The paths of the tree under a prefix (the prefix itself included) matching a name test. */
  pathsUnder(prefix: string, name: RegExp): string[] {
    return this.tree.paths.filter((path) => (path === prefix || path.startsWith(`${prefix}/`)) && name.test(path.slice(path.lastIndexOf('/') + 1))).sort(byCodePoint);
  }

  /** Every tree path whose basename matches. */
  pathsNamed(name: RegExp): string[] {
    return this.tree.paths.filter((path) => name.test(path.slice(path.lastIndexOf('/') + 1))).sort(byCodePoint);
  }

  /** A span over one whole file. */
  spanOfFile(path: string): SourceSpan {
    const bytes = this.tree.read(path);
    const lines = this.lines(path);
    return { path, byteStart: 0, byteEnd: bytes.length, lineStart: 1, lineEnd: Math.max(lines.length, 1) };
  }

  /** A span over one 1-based line. */
  spanOfLine(path: string, line: number): SourceSpan {
    const lines = this.lines(path);
    const text = lines[line - 1] ?? '';
    return this.spanOfChars(path, lineStart(lines, line), lineStart(lines, line) + text.length, line, line);
  }

  /** A span from one 1-based line through another, both whole. */
  spanOfLines(path: string, first: number, last: number): SourceSpan {
    const lines = this.lines(path);
    const held: string[] = [];
    for (let line = first; line <= last && line <= lines.length; line += 1) held.push(lines[line - 1] ?? '');
    const start = lineStart(lines, first);
    return this.spanOfChars(path, start, start + held.join('\n').length, first, Math.min(last, Math.max(lines.length, 1)));
  }

  /** The first span whose text holds the needle, from a 1-based line on. */
  spanAround(path: string, needle: string, fromLine = 1): SourceSpan | undefined {
    const text = this.text(path);
    const at = text.indexOf(needle, charOfLine(this.lines(path), fromLine));
    if (at < 0) return undefined;
    const lines = this.lines(path);
    const first = lineOfChar(lines, at);
    const last = lineOfChar(lines, at + needle.length);
    return this.spanOfChars(path, at, at + needle.length, first, last);
  }

  /**
   * A span from a character offset to another, over the decoded text: the byte
   * offsets the records contract asks for, computed over the same text.
   */
  spanOfChars(path: string, startChar: number, endChar: number, lineStart_: number, lineEnd_: number): SourceSpan {
    const text = this.text(path);
    const bytes = this.tree.read(path);
    const byteStart = startChar >= text.length ? bytes.length : encoder.encode(text.slice(0, startChar)).length;
    const byteEnd = endChar >= text.length ? bytes.length : encoder.encode(text.slice(0, endChar)).length;
    return { path, byteStart, byteEnd, lineStart: lineStart_, lineEnd: Math.max(lineEnd_, lineStart_) };
  }
}

/** The character offset a 1-based line starts at. */
function lineStart(lines: readonly string[], line: number): number {
  let at = 0;
  for (let index = 0; index < line - 1 && index < lines.length; index += 1) at += (lines[index]?.length ?? 0) + 1;
  return at;
}

/** The 1-based line a character offset stands on. */
function lineOfChar(lines: readonly string[], at: number): number {
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    seen += (lines[index]?.length ?? 0) + 1;
    if (at < seen) return index + 1;
  }
  return Math.max(lines.length, 1);
}

/** The character offset of a 1-based line's start (for searches from a line on). */
function charOfLine(lines: readonly string[], line: number): number {
  return lineStart(lines, line);
}

/** The service folder a repository path under services/ belongs to, or undefined. */
export function serviceOf(path: string): string | undefined {
  const match = /^services\/([^/]+)\//.exec(path);
  return match?.[1];
}
