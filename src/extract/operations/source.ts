/**
 * Reading one tree's text: the decoded bytes, the lines, and the spans records
 * point at. Offsets are bytes (records.ts), lines are 1-based; both come from
 * the same decoded text, so a span made here is the span the bytes hold.
 */
import type { Extraction, SourceSpan, TreeReader } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type {
  CodeBindingFact, CodeCallFact, CodeExpressionFact, CodeExportFact, CodeFactId, CodeFacts, CodeFieldFact, CodeFileFact, CodeImportFact, CodeSiteFact, CodeSymbolFact,
} from '../code/facts.js';
import {codeFactsOf} from '../code/index.js';
import { evaluateLibraryModels } from '../library-models/evaluate.js';
import { serviceOfPath, serviceUnits, unitIndex, unitOfPath, type ServiceUnit, type UnitIndex } from '../service-units.js';
import type { LibraryEvaluation } from '../library-models/model.js';
import type { FunctionSite } from './symbol-sites.js';

const encoder = new TextEncoder();

const EMPTY_INDEX: readonly never[] = [];
Object.freeze(EMPTY_INDEX);

/**
 * One view's index of a fact array: every entry the facts hold under a key,
 * in the order they hold it. Groups stay arrays, never single values, so a
 * duplicate id or key remains visible to the proofs that must fail on one,
 * and a key the facts do not hold answers with no entry at all — the answer
 * the whole-array scan it replaces always gave.
 */
export class FactIndex<T> {
  /** One entry is held as itself; only a repeated key allocates an array. */
  private constructor(private readonly groups: ReadonlyMap<string, T | readonly T[]>) {}

  private static build<T>(entries: Iterable<readonly [string, T]>): FactIndex<T> {
    const grouped = new Map<string, T | T[]>();
    for (const [at, item] of entries) {
      const held = grouped.get(at);
      if (held === undefined) grouped.set(at, item);
      else if (Array.isArray(held)) held.push(item);
      else grouped.set(at, [held as T, item]);
    }
    return new FactIndex<T>(grouped);
  }

  static fromItems<T>(items: readonly T[], key: (item: T) => string): FactIndex<T> {
    return FactIndex.build((function* () { for (const item of items) yield [key(item), item] as const; })());
  }

  static fromPairs<T>(pairs: Iterable<readonly [string, T]>): FactIndex<T> {
    return FactIndex.build(pairs);
  }

  /** Every entry under one key, in the facts' own order; none when nothing matches. */
  all(key: string): readonly T[] {
    const held = this.groups.get(key);
    if (held === undefined) return EMPTY_INDEX;
    return Array.isArray(held) ? held : [held as T];
  }

  /** The keys this index holds. */
  keys(): readonly string[] {
    return [...this.groups.keys()];
  }
}

/** One index that holds one entry per item, grouped by a key of that item. */
function groupedBy<T>(items: readonly T[] | undefined, key: (item: T) => string): FactIndex<T> {
  return FactIndex.fromItems(items ?? [], key);
}

export const spanKey = (span: SourceSpan): string => JSON.stringify([span.path, span.byteStart, span.byteEnd]);

export class TreeText {
  /** The tree's paths, as a set for `has`. */
  readonly has: (path: string) => boolean;

  private readonly texts = new Map<string, string>();
  private readonly linesCache = new Map<string, readonly string[]>();

  readonly tree: TreeReader;
  private libraryCache: LibraryEvaluation | undefined;
  private unitCache: UnitIndex | undefined;
  readonly factGaps = new Map<string, { readonly path: string; readonly reason: string }>();
  factGap(path: string, reason: string): void { this.factGaps.set(JSON.stringify([path, reason]), {path, reason}); }

  /** The units the tree declares, read once: a service is what the repository says it is, never a folder shape. */
  units(): UnitIndex {
    return this.unitCache ??= unitIndex(serviceUnits(this.tree));
  }

  /** The unit a path belongs to, or undefined outside every declared unit. */
  unitOf(path: string): ServiceUnit | undefined {
    return unitOfPath(this.units(), path);
  }

  /** The name of the unit a path belongs to, or undefined outside every declared unit. */
  serviceOf(path: string): string | undefined {
    return serviceOfPath(this.units(), path);
  }

  libraryFacts(): LibraryEvaluation | undefined {
    if (this.facts === undefined) return undefined;
    this.libraryCache ??= evaluateLibraryModels(this.facts);
    return this.libraryCache;
  }

  readonly facts: CodeFacts | undefined;

  /**
   * The view's immutable fact indexes, built once for this view and never
   * shared with another one: expressions by path and by id, child ids by their
   * parent's id, calls by their call expression, bindings by id and by
   * initializer, symbols by path and by key, imports by path and files by path.
   */
  readonly expressionsByPath: FactIndex<CodeExpressionFact>;
  readonly expressionsById: FactIndex<CodeExpressionFact>;
  readonly childrenByParent: FactIndex<CodeFactId>;
  readonly callsByExpression: FactIndex<CodeCallFact>;
  readonly bindingsById: FactIndex<CodeBindingFact>;
  readonly bindingsByInitializer: FactIndex<CodeBindingFact>;
  readonly symbolsByPath: FactIndex<CodeSymbolFact>;
  readonly symbolsByKey: FactIndex<CodeSymbolFact>;
  readonly importsByPath: FactIndex<CodeImportFact>;
  readonly filesByPath: FactIndex<CodeFileFact>;
  /** The same facts under the keys the HTTP proofs ask for, built once instead of rescanned per call. */
  readonly expressionsBySyntax: FactIndex<CodeExpressionFact>;
  readonly expressionsBySpan: FactIndex<CodeExpressionFact>;
  readonly parentsByChild: FactIndex<CodeExpressionFact>;
  readonly sitesBySpan: FactIndex<CodeSiteFact>;
  readonly exportsById: FactIndex<CodeExportFact>;
  readonly fieldsByKey: FactIndex<CodeFieldFact>;

  /** The callable sites this view has already proved, and the bytes' boundary tables. */
  private readonly callables = new Map<string, readonly FunctionSite[]>();
  private readonly boundaries = new Map<string, Int32Array>();

  constructor(tree: TreeReader, readonly code?: Extraction, facts?: CodeFacts) {
    this.tree = tree;
    this.facts = facts ?? (code === undefined ? undefined : codeFactsOf(code, tree));
    const paths = new Set(tree.paths);
    this.has = (path) => paths.has(path);
    this.expressionsByPath = groupedBy(this.facts?.expressions, (expression) => expression.path);
    this.expressionsById = groupedBy(this.facts?.expressions, (expression) => expression.id);
    this.childrenByParent = FactIndex.fromPairs((function* (facts: CodeFacts | undefined) { for (const expression of facts?.expressions ?? []) for (const child of expression.children) yield [expression.id, child] as const; })(this.facts));
    this.callsByExpression = groupedBy(this.facts?.calls, (call) => call.expression);
    this.bindingsById = groupedBy(this.facts?.bindings, (binding) => binding.id);
    this.bindingsByInitializer = groupedBy((this.facts?.bindings ?? []).filter((binding) => binding.initializer !== undefined),
      (binding) => binding.initializer!);
    this.symbolsByPath = groupedBy(this.facts?.symbols, (symbol) => symbol.path);
    this.symbolsByKey = groupedBy(this.facts?.symbols, (symbol) => symbol.key);
    this.importsByPath = groupedBy(this.facts?.imports, (entry) => entry.path);
    this.filesByPath = groupedBy(this.facts?.files, (file) => file.path);
    this.expressionsBySyntax = groupedBy(this.facts?.expressions, (expression) => expression.syntaxKind);
    this.expressionsBySpan = groupedBy(this.facts?.expressions, (expression) => spanKey(expression.span));
    this.parentsByChild = FactIndex.fromPairs((function* (facts: CodeFacts | undefined) { for (const expression of facts?.expressions ?? []) for (const child of expression.children) yield [child, expression] as const; })(this.facts));
    this.sitesBySpan = groupedBy(this.facts?.sites, (site) => spanKey(site.span));
    this.exportsById = groupedBy(this.facts?.exports, (entry) => entry.id);
    this.fieldsByKey = groupedBy(this.facts?.fields, (field) => field.key);
  }

  /** The callable sites already proved for a path in this view, when one asked before. */
  callableSites(path: string): readonly FunctionSite[] | undefined {
    return this.callables.get(path);
  }

  /** Keep the callable sites one path was proved to have, for every later question about it. */
  rememberCallableSites(path: string, sites: readonly FunctionSite[]): readonly FunctionSite[] {
    const held: FunctionSite[] = [...sites];
    Object.freeze(held);
    this.callables.set(path, held);
    return held;
  }

  /**
   * The character offset each UTF-8 boundary of a path's bytes stands at,
   * built once for this view. A boundary a fatal UTF-8 decode refuses stays -1,
   * so a span that is not a boundary is refused exactly as the prefix decode
   * that used to answer this question refused it.
   */
  charBoundaries(path: string): Int32Array {
    const held = this.boundaries.get(path);
    if (held !== undefined) return held;
    const bytes = this.tree.read(path);
    const table = new Int32Array(bytes.length + 1).fill(-1);
    table[0] = 0;
    // A leading byte order mark is not a character of the decoded text.
    let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    table[at] = 0;
    let chars = 0;
    while (at < bytes.length) {
      const length = utf8Length(bytes, at);
      if (length === undefined || at + length > bytes.length) break;
      at += length;
      chars += length === 4 ? 2 : 1;
      table[at] = chars;
    }
    this.boundaries.set(path, table);
    return table;
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
    // A literal search for a string the caller already holds: the comparison is of characters, never a pattern.
    const at = indexOfText(text, needle, charOfLine(this.lines(path), fromLine));
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

/**
 * The byte length of the UTF-8 sequence a byte offset starts, or undefined
 * where a fatal UTF-8 decoder refuses it: an overlong form, a surrogate, a
 * code point past U+10FFFF, a stray continuation or a sequence cut short.
 */
function utf8Length(bytes: Uint8Array, at: number): number | undefined {
  const lead = bytes[at];
  if (lead === undefined) return undefined;
  const continuation = (index: number): boolean => {
    const byte = bytes[index];
    return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
  };
  const second = bytes[at + 1];
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return continuation(at + 1) ? 2 : undefined;
  if (lead === 0xe0) return second !== undefined && second >= 0xa0 && second <= 0xbf && continuation(at + 2) ? 3 : undefined;
  if (lead >= 0xe1 && lead <= 0xec) return continuation(at + 1) && continuation(at + 2) ? 3 : undefined;
  if (lead === 0xed) return second !== undefined && second >= 0x80 && second <= 0x9f && continuation(at + 2) ? 3 : undefined;
  if (lead >= 0xee && lead <= 0xef) return continuation(at + 1) && continuation(at + 2) ? 3 : undefined;
  if (lead === 0xf0) return second !== undefined && second >= 0x90 && second <= 0xbf && continuation(at + 2) && continuation(at + 3) ? 4 : undefined;
  if (lead >= 0xf1 && lead <= 0xf3) return continuation(at + 1) && continuation(at + 2) && continuation(at + 3) ? 4 : undefined;
  if (lead === 0xf4) return second !== undefined && second >= 0x80 && second <= 0x8f && continuation(at + 2) && continuation(at + 3) ? 4 : undefined;
  return undefined;
}

/** The units one tree declares: read once per extractor run, not once per file. */
export function declaredUnits(tree: TreeReader): UnitIndex {
  return unitIndex(serviceUnits(tree));
}

/** The first place a literal string stands in a text, from a character offset on: no pattern, one comparison of characters. */
function indexOfText(text: string, needle: string, from = 0): number {
  if (needle === '') return from <= text.length ? from : -1;
  const last = text.length - needle.length;
  for (let at = Math.max(0, from); at <= last; at += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (text[at + offset] !== needle[offset]) { matched = false; break; }
    }
    if (matched) return at;
  }
  return -1;
}
