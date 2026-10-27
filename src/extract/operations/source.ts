/**
 * Reading one tree's text: the decoded bytes, the lines, and the spans records
 * point at. Offsets are bytes (records.ts), lines are 1-based; both come from
 * the same decoded text, so a span made here is the span the bytes hold.
 */
import type { Extraction, SourceSpan, TreeReader } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type {
  CodeBindingFact, CodeExpressionFact, CodeFactId, CodeFacts, CodeFileFact, CodeImportFact, CodeSymbolFact,
} from '../code/facts.js';
import {codeFactsOf} from '../code/index.js';
import { evaluateLibraryModels } from '../library-models/evaluate.js';
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
  private readonly groups: ReadonlyMap<string, readonly T[]>;

  constructor(entries: Iterable<readonly [string, T]>) {
    const grouped = new Map<string, T[]>();
    for (const [key, entry] of entries) {
      const held = grouped.get(key);
      if (held === undefined) grouped.set(key, [entry]);
      else held.push(entry);
    }
    const groups = new Map<string, readonly T[]>();
    for (const [key, held] of grouped) {
      Object.freeze(held);
      groups.set(key, held);
    }
    this.groups = groups;
  }

  /** Every entry under one key, in the facts' own order; none when nothing matches. */
  all(key: string): readonly T[] {
    return this.groups.get(key) ?? EMPTY_INDEX;
  }

  /** The keys this index holds. */
  keys(): readonly string[] {
    return [...this.groups.keys()];
  }
}

/** One index that holds one entry per item, grouped by a key of that item. */
function groupedBy<T>(items: readonly T[] | undefined, key: (item: T) => string): FactIndex<T> {
  return new FactIndex((items ?? []).map((item) => [key(item), item] as const));
}

/** The paths of one tree as a membership test, made once and read by every pass over it. */
function hasOf(tree: TreeReader): (path: string) => boolean {
  const paths = new Set(tree.paths);
  return (path) => paths.has(path);
}

/**
 * One tree read as text and as its shared facts: the decoded bytes, the lines,
 * the spans records point at, the fact indexes and the library evaluation. The
 * view of a tree (`treeView`) is made once; the passes over it (`pass`) read its
 * indexes, text and evaluation instead of building them again, and each pass
 * keeps its own record of the paths it could not read, so a gap one extractor
 * proves is never reported by another over the same tree.
 */
export class TreeText {
  /** The tree's paths, as a set for `has`. */
  readonly has: (path: string) => boolean;

  private readonly texts: Map<string, string>;
  private readonly linesCache: Map<string, readonly string[]>;
  private readonly boundaries: Map<string, Int32Array>;
  private readonly library: {evaluation?: LibraryEvaluation};

  readonly tree: TreeReader;
  readonly factGaps = new Map<string, { readonly path: string; readonly reason: string }>();
  factGap(path: string, reason: string): void { this.factGaps.set(JSON.stringify([path, reason]), {path, reason}); }

  libraryFacts(): LibraryEvaluation | undefined {
    if (this.facts === undefined) return undefined;
    this.library.evaluation ??= evaluateLibraryModels(this.facts);
    return this.library.evaluation;
  }

  readonly facts: CodeFacts | undefined;

  /**
   * The view's immutable fact indexes, built once for this view and read by
   * every pass over it: expressions by path and by id, child ids by their
   * parent's id, bindings by id and by initializer, symbols by path and by key,
   * imports by path and files by path.
   */
  readonly expressionsByPath: FactIndex<CodeExpressionFact>;
  readonly expressionsById: FactIndex<CodeExpressionFact>;
  readonly childrenByParent: FactIndex<CodeFactId>;
  readonly bindingsById: FactIndex<CodeBindingFact>;
  readonly bindingsByInitializer: FactIndex<CodeBindingFact>;
  readonly symbolsByPath: FactIndex<CodeSymbolFact>;
  readonly symbolsByKey: FactIndex<CodeSymbolFact>;
  readonly importsByPath: FactIndex<CodeImportFact>;
  readonly filesByPath: FactIndex<CodeFileFact>;

  /**
   * The callable sites this pass has already proved. They stay this pass's own:
   * proving a path's sites also records the paths it could not read, and a pass
   * that read a proof another pass had made would report none of that.
   */
  private readonly callables = new Map<string, readonly FunctionSite[]>();

  /**
   * Reads one tree. With `view` given, everything the facts' indexes, the text,
   * the byte boundaries and the library evaluation hold is the view's, so a
   * later pass over the same tree builds none of it again.
   */
  constructor(tree: TreeReader, readonly code?: Extraction, facts?: CodeFacts, view?: TreeText) {
    this.tree = tree;
    this.facts = view !== undefined ? view.facts : facts ?? (code === undefined ? undefined : codeFactsOf(code, tree));
    const held = this.facts;
    this.has = view !== undefined ? view.has : hasOf(tree);
    this.texts = view !== undefined ? view.texts : new Map<string, string>();
    this.linesCache = view !== undefined ? view.linesCache : new Map<string, readonly string[]>();
    this.boundaries = view !== undefined ? view.boundaries : new Map<string, Int32Array>();
    this.library = view !== undefined ? view.library : {};
    this.expressionsByPath = view !== undefined ? view.expressionsByPath : groupedBy(held?.expressions, (expression) => expression.path);
    this.expressionsById = view !== undefined ? view.expressionsById : groupedBy(held?.expressions, (expression) => expression.id);
    this.childrenByParent = view !== undefined ? view.childrenByParent : new FactIndex((held?.expressions ?? []).flatMap((expression) =>
      expression.children.map((child) => [expression.id, child] as const)));
    this.bindingsById = view !== undefined ? view.bindingsById : groupedBy(held?.bindings, (binding) => binding.id);
    this.bindingsByInitializer = view !== undefined ? view.bindingsByInitializer : groupedBy((held?.bindings ?? []).filter((binding) => binding.initializer !== undefined),
      (binding) => binding.initializer!);
    this.symbolsByPath = view !== undefined ? view.symbolsByPath : groupedBy(held?.symbols, (symbol) => symbol.path);
    this.symbolsByKey = view !== undefined ? view.symbolsByKey : groupedBy(held?.symbols, (symbol) => symbol.key);
    this.importsByPath = view !== undefined ? view.importsByPath : groupedBy(held?.imports, (entry) => entry.path);
    this.filesByPath = view !== undefined ? view.filesByPath : groupedBy(held?.files, (file) => file.path);
  }

  /**
   * One pass's reader over this view: the view's facts, indexes, text, byte
   * boundaries and library evaluation, and a record of its own of the paths it
   * could not read.
   */
  pass(): TreeText {
    return new TreeText(this.tree, this.code, this.facts, this);
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

/** What a tree's view was built from, and the view itself. */
interface HeldView {
  readonly code: Extraction | undefined;
  readonly facts: CodeFacts | undefined;
  readonly view: TreeText;
}

/** Every tree's view, keyed by the very reader it reads. */
const views = new WeakMap<TreeReader, HeldView>();

/**
 * The operations fact view of one tree (madarch-mwhd.3): the facts, their
 * indexes, the decoded text, the byte boundaries and the library evaluation of
 * one reader, built on the first question and read by every later one, so the
 * tree's two extractors pay for each of them once. The entry is keyed by the
 * reader object itself: a view never outlives the tree it was read from, since
 * an entry whose value names its key is collected with the key, and
 * `releaseTreeView` drops it the moment that tree's work ends. A question that
 * brings another code extraction or another fact set than the held one builds
 * its own view, exactly as the first question did.
 */
export function treeView(tree: TreeReader, code?: Extraction, facts?: CodeFacts): TreeText {
  const held = views.get(tree);
  if (held !== undefined && held.code === code && held.facts === facts) return held.view;
  const view = new TreeText(tree, code, facts);
  views.set(tree, { code, facts, view });
  return view;
}

/** Drops a tree's view when that tree's work ends: the next question about its reader builds a new one. */
export function releaseTreeView(tree: TreeReader): void {
  views.delete(tree);
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

/** The service folder a repository path under services/ belongs to, or undefined. */
export function serviceOf(path: string): string | undefined {
  const match = /^services\/([^/]+)\//.exec(path);
  return match?.[1];
}
