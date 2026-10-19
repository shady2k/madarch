/**
 * What one file's resolution becomes (madarch-tzte.21.6): the `occurrence` of
 * each mention the file makes, the `call`, `reference` and `inherits` edges
 * those mentions fold into, and the file's `coverage` — what was read and what
 * could not be.
 *
 * **What the resolver resolves.** A mention names a symbol of this repository
 * when the name is bound
 *
 * 1. by a declaration of the file the mention stands in — the nearest one that
 *    is in scope at the mention and stands before it (a local declaration
 *    shadows an import of the same name from its own line on, a method beats a
 *    top-level function of the same name inside it), else a top-level one, both
 *    as stage 3 published them as `symbol` facts;
 * 2. by an import of the file whose specifier is a relative one this stage can
 *    tie to a file of the repository (`{ create }`, `create as make`, a default
 *    import, and `ns.create` through a namespace binding), the symbol then
 *    being the named declaration of that file (the `default` one for a default
 *    import);
 * 3. by a compiler's index, where the wiring has one: the symbol the index
 *    names at the mention's own place, taken whatever this file binds.
 *
 * **What it does not.** A mention of a name bound by a parameter, or by a name
 * nothing in the file binds (a global, a built-in, an ambient declaration), is
 * not a mention of a symbol of this repository, and no edge is drawn to a
 * guess. A mention of a name imported from a package outside the repository is
 * the same: the package's own symbols are not in the graph, and the file's
 * coverage names the import once instead of leaving a wrong edge or a silence.
 * A member of an access (`order.total`) is no mention at all: which member of
 * which type a name reaches is a compiler's answer, not a syntactic reader's.
 *
 * **Unresolved is written, never dropped.** A mention the resolver claims and
 * cannot tie to a symbol — the specifier names no file, the file declares no
 * such name, the mention stands in no symbol the file declares, so nothing can
 * be the edge's caller — is a coverage gap naming the name and its own place
 * (`src/a.ts:3:14`), which is what "not enough data" means in 0005's sense.
 *
 * The module is pure: it reads its request and nothing else, and the same
 * request answers the same facts with the same ids.
 */
import { byCodePoint } from '../../model/order.js';
import {
  makeEdgeFact, makeNodeFact,
  type CoverageGap, type CoverageValue, type Fact, type FactPlace, type FactProvenance, type FactRange, type FactSource,
  type InheritsForm, type RepositoryPath, type ResolutionPrecision, type SymbolKind,
} from '../facts.js';
import { isRelativeSpecifier, resolveSpecifier } from './syntax-facts.js';
import type { ExtractedFileResolution, ExtractedResolutionMention } from './resolution-extract.js';

/**
 * The reader every fact of this stage cites as its source. The resolution is
 * this fill's own reading of what a file binds and mentions; the compiler's
 * index, where a wiring has one, answers *which* symbol a mention names and is
 * named by the edge's `precision`, not by a second source: one reader wrote
 * the fact, and the precision says what it stood on.
 */
export const RESOLUTION_SOURCE: FactSource = { system: 'madarch-resolution', version: '1' };

/** One symbol of a file, as the graph answers it: stage 3's `symbol` fact, in the parts a resolution reads. */
export interface ResolutionSymbolRow {
  /** The symbol fact's id. */
  readonly id: string;
  /** The file the symbol is declared in. */
  readonly file: RepositoryPath;
  /** The symbol's qualified name inside the file (`OrderService.create`). */
  readonly qualifiedName: string;
  readonly symbolKind: SymbolKind;
  /** The declaration's own range: what tells whether a mention stands inside it, and which declaration is nearest. */
  readonly range: FactRange;
}

/** One mention a compiler's index resolved: the symbol the name at that place names. */
export interface IndexResolutionRow {
  /** The mention's line, 1-based, as this fill counts them. */
  readonly line: number;
  /** The mention's column in that line, 0-based, in UTF-16 code units. */
  readonly column: number;
  /** The symbol fact's id the name at that place names. */
  readonly symbol: string;
}

/** Everything one file's resolution reads: the file's findings, and the graph's symbols. */
export interface ResolutionRequest {
  /** The product's own name for the repository, as the facts carry it. */
  readonly repository: string;
  /** The commit the bytes were read at: 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /** The file's repository path. */
  readonly path: RepositoryPath;
  readonly findings: ExtractedFileResolution;
  /** Every file path the pinned tree holds, so a specifier is tied to a file of this repository. */
  readonly files: readonly string[];
  /** The symbols of this file, as the graph holds them. */
  readonly fileSymbols: readonly ResolutionSymbolRow[];
  /** The symbols of each other file this resolution read, by that file's path. */
  readonly readSymbols: ReadonlyMap<string, readonly ResolutionSymbolRow[]>;
  /** What a compiler's index resolved, by the mention's place (`line:column`); empty where there is none. */
  readonly index: ReadonlyMap<string, string>;
  /**
   * Whether a compiler's index answered for this file at all: named in the
   * file's coverage where it did not. One repository may hold an index that
   * resolved some files and not this one, and the gap says which file it is
   * about rather than claiming the repository has none.
   */
  readonly indexAnswered: boolean;
  /** The reader the facts cite; `RESOLUTION_SOURCE` where a caller names none. */
  readonly source?: FactSource;
}

/** One file's resolution, as facts. */
export interface ResolutionFactSet {
  /** Every fact the file's resolution makes, in code point order of kind and id. */
  readonly facts: readonly Fact[];
  /** The file's coverage: what was read, and every gap with its reason. */
  readonly coverage: CoverageValue;
  /** How many mentions the resolution tied to a symbol, and how many it could not. */
  readonly resolvedMentions: number;
  readonly unresolvedMentions: number;
}

/** The facts one file's findings make, with the coverage it was resolved with. */
export function resolutionFacts(request: ResolutionRequest): ResolutionFactSet {
  const source = request.source ?? RESOLUTION_SOURCE;
  const repository = { id: request.repository, commit: request.commit };
  const at = (span: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number }): FactProvenance => ({
    source,
    repository,
    place: placeOf(request.path, span),
  });
  const known = new Set<string>(request.files);
  const facts: Fact[] = [];
  const unread: CoverageGap[] = [...request.findings.unread];
  // What the resolution read: the file itself where a syntax tree was made of
  // it, and every file whose symbols the request carries — the files the unit
  // read for the names this file's imports bind. A file no grammar reads has
  // nothing this resolution read, and its coverage says so.
  const read = new Set<string>(request.findings.parsed ? [request.path, ...request.readSymbols.keys()] : []);
  const sites: Site[] = [];
  let unresolved = 0;

  // The bindings the file's imports make, and the file each one names. Two
  // failures are told apart: a package outside the repository (whose symbols the
  // graph holds no node for, named once for the import) and a relative specifier
  // that names no file of this repository (a reference this resolution claims and
  // cannot tie down, so each use of one of its names is a gap with its own place).
  const bindings = new Map<string, Binding>();
  for (const entry of request.findings.imports) {
    const target = resolveSpecifier(request.path, entry.specifier, known);
    if (target === undefined) {
      if (isRelativeSpecifier(entry.specifier)) {
        // The import itself is named, so a specifier that names no file is a gap
        // even where no use of the name follows, and each use of it is a gap of
        // its own with its place (see `bindMention`).
        unread.push({
          what: `${request.path} imports ${JSON.stringify(entry.specifier)}, which names no file of this repository`,
          reason: 'unsupported',
        });
        bindings.set(entry.local, {
          target: undefined,
          imported: entry.imported,
          unresolved: `the specifier ${JSON.stringify(entry.specifier)} names no file of this repository`,
        });
      } else {
        unread.push({
          what: `${request.path} imports ${JSON.stringify(entry.specifier)}, which names a package outside this repository`,
          reason: 'unsupported',
        });
      }
      continue;
    }
    bindings.set(entry.local, { target, imported: entry.imported });
  }

  for (const mention of request.findings.mentions) {
    const key = `${mention.span.startLine}:${mention.span.startColumn}`;
    const fromIndex = request.index.get(key);
    let target: ResolvedSymbol | undefined;
    let precision: ResolutionPrecision = 'syntactic';
    if (fromIndex !== undefined) {
      // A compiler's index is consulted before anything this file binds: it
      // answers the symbol at the place, and a name a parameter or a package
      // shadows is exactly where the syntactic reader is weakest.
      target = { id: fromIndex };
      precision = 'compiler';
    } else {
      if (mention.parameterBound) continue;
      const tied = bindMention(request, mention, bindings);
      if (tied.kind === 'resolved') target = tied.symbol;
      else if (tied.kind === 'out-of-claim') continue;
      else {
        unresolved += 1;
        unread.push({ what: `${mention.name} at ${request.path}:${mention.span.startLine}:${mention.span.startColumn}, ${tied.why}`, reason: 'unsupported' });
        continue;
      }
    }
    // The caller: the innermost symbol of this file whose own span holds the
    // mention. An edge names two symbols, and a mention standing in no symbol
    // of the file has no caller to name.
    const caller = innermostSymbol(request.fileSymbols, mention.span.startLine, mention.span.startColumn);
    if (caller === undefined) {
      unresolved += 1;
      unread.push({
        what: `${mention.name} at ${request.path}:${mention.span.startLine}:${mention.span.startColumn}, whose ${mention.use} stands in no symbol this file declares`,
        reason: 'unsupported',
      });
      continue;
    }
    facts.push(makeNodeFact({
      kind: 'occurrence',
      layer: 'extracted',
      provenance: at(mention.span),
      value: { symbol: target.id, roles: [mention.access] },
    }));
    sites.push({ mention, from: caller.id, to: target.id, precision });
  }

  for (const fact of foldSites(sites, at)) facts.push(fact);

  // The compiler's index, named where it answered nothing for this file: the
  // resolution above is the syntactic fallback, and a reader of the file's
  // coverage sees that no compiler resolved a name here.
  if (!request.indexAnswered && request.findings.parsed) {
    unread.push({
      what: `a compiler index of ${request.path} (a SCIP indexer), which would resolve a name the syntax cannot`,
      reason: 'unsupported',
    });
  }

  const coverage: CoverageValue = {
    repository: request.repository,
    scope: request.path,
    complete: unread.length === 0,
    read: [...read].sort(byCodePoint),
    unread: mergeGaps(unread),
  };
  facts.push(makeNodeFact({ kind: 'coverage', layer: 'extracted', provenance: { source, repository }, value: coverage }));

  return {
    facts: oneFactPerId(facts, request.path),
    coverage,
    resolvedMentions: sites.length,
    unresolvedMentions: unresolved,
  };
}

/** One mention the resolution tied to a symbol, before the edges are folded. */
interface Site {
  readonly mention: ExtractedResolutionMention;
  readonly from: string;
  readonly to: string;
  readonly precision: ResolutionPrecision;
}

/** One symbol a name resolved to: the fact id the edge's end and the occurrence name. */
interface ResolvedSymbol {
  readonly id: string;
}

/**
 * What an import binds in a file: the file the specifier names, and what of that
 * file the name stands for. A relative specifier that names no file of the
 * repository binds a name too — with no target, and the reason a mention of it
 * is written as unresolved with its own place.
 */
interface Binding {
  readonly target: string | undefined;
  readonly imported: ExtractedFileResolution['imports'][number]['imported'];
  readonly unresolved?: string;
}

/** What binding a mention answered: a symbol, a claim this resolver does not make, or a failure with its reason. */
type BoundMention =
  | { readonly kind: 'resolved'; readonly symbol: ResolvedSymbol }
  | { readonly kind: 'out-of-claim' }
  | { readonly kind: 'unresolved'; readonly why: string };

/**
 * The symbol one mention names, by the file's own declarations, then by the
 * imports it binds. A mention this resolver does not claim — a name nothing in
 * the file binds, or a namespace whose package is outside the repository — is
 * `out-of-claim` rather than a gap: it is not a reference this reader promised
 * to resolve.
 */
function bindMention(
  request: ResolutionRequest,
  mention: ExtractedResolutionMention,
  bindings: ReadonlyMap<string, Binding>,
): BoundMention {
  if (mention.through !== undefined) {
    // `ns.name`: the member's name is resolved through the namespace binding, so
    // the file the binding names is the one the name is looked for in.
    const binding = bindings.get(mention.through);
    if (binding === undefined || binding.imported.form !== 'namespace') return { kind: 'out-of-claim' };
    if (binding.target === undefined) return { kind: 'unresolved', why: binding.unresolved ?? 'the binding names no file of this repository' };
    const symbol = topLevelSymbol(symbolsOf(request, binding.target), mention.name);
    if (symbol === undefined) {
      return { kind: 'unresolved', why: `the file ${binding.target} declares no ${JSON.stringify(mention.name)} the namespace names` };
    }
    return { kind: 'resolved', symbol };
  }
  const declared = nearestDeclaration(request.fileSymbols, mention)
    ?? topLevelSymbol(request.fileSymbols, mention.name);
  if (declared !== undefined) return { kind: 'resolved', symbol: declared };
  const binding = bindings.get(mention.name);
  if (binding === undefined) return { kind: 'out-of-claim' };
  // A namespace binding names a module, and the schema holds no symbol for a
  // module: a bare mention of it (`f(ns)`, `return ns`) names nothing an edge can
  // end at, and it is out of this reader's claim rather than a guess.
  if (binding.imported.form === 'namespace') return { kind: 'out-of-claim' };
  if (binding.target === undefined) return { kind: 'unresolved', why: binding.unresolved ?? 'the binding names no file of this repository' };
  const symbols = symbolsOf(request, binding.target);
  const wanted = binding.imported.form === 'named' ? binding.imported.name : 'default';
  const symbol = topLevelSymbol(symbols, wanted);
  if (symbol === undefined) {
    return { kind: 'unresolved', why: `the file ${binding.target} declares no ${JSON.stringify(wanted)}, which is what the import binds ${JSON.stringify(mention.name)} to` };
  }
  return { kind: 'resolved', symbol };
}

/** The symbols of one file this resolution read; a file the request carries none for answers none. */
function symbolsOf(request: ResolutionRequest, path: string): readonly ResolutionSymbolRow[] {
  return request.readSymbols.get(path) ?? [];
}

/** The top-level declaration of a set of symbols by its own name (`create`), never a member (`Order.create`). */
function topLevelSymbol(symbols: readonly ResolutionSymbolRow[], name: string): ResolvedSymbol | undefined {
  const held = symbols
    .filter((symbol) => symbol.qualifiedName === name)
    .sort((left, right) => byCodePoint(left.id, right.id));
  const first = held[0];
  return first === undefined ? undefined : { id: first.id };
}

/**
 * The declaration of the file a mention of one name binds: the nearest one that
 * is *in scope* at the mention and stands before it. In scope means the
 * declaration's container is the mention's own or one of its ancestors (`run`
 * for a mention inside `run`, the file for a top-level one), and the nearest of
 * those is the deepest container, then the latest start — so a local `const`
 * shadows an import of the same name from its own line on, a method beats a
 * top-level function of the same name inside it, and a declaration of another
 * function is never reached. A declaration that stands *after* the mention binds
 * it where the language gives it that scope — a hoisted `function` anywhere in
 * its scope, and a `const`, a `let` or a class before its own line, which is a
 * temporal dead zone and not another binding — and there the nearest one wins, by
 * the same order.
 */
function nearestDeclaration(symbols: readonly ResolutionSymbolRow[], mention: ExtractedResolutionMention): ResolvedSymbol | undefined {
  const chain = enclosingChain(symbols, mention.span.startLine, mention.span.startColumn);
  const inScope = symbols
    .filter((symbol) => namePartOf(symbol.qualifiedName) === mention.name)
    .filter((symbol) => inScopeOf(chain, containerOf(symbol.qualifiedName)))
    // Only a declaration held by a *lexical* scope of the file shadows a name: a
    // class, an interface, an enum or a struct holds members, and no bare name of
    // a method body reaches one (`total()` inside a method is the file's own
    // `total`, never the method beside it).
    .filter((symbol) => isLexicalScope(symbols, containerOf(symbol.qualifiedName)));
  const before = inScope
    .filter((symbol) => startsBefore(symbol.range, mention.span.startLine, mention.span.startColumn))
    .sort((left, right) =>
      containerOf(right.qualifiedName).length - containerOf(left.qualifiedName).length
      || right.range.startLine - left.range.startLine
      || right.range.startColumn - left.range.startColumn
      || byCodePoint(left.id, right.id));
  const chosen = before[0];
  if (chosen !== undefined) return { id: chosen.id };
  // Nothing in scope starts before the mention, so a declaration that stands
  // after it still binds it where the language gives it that scope: a hoisted
  // `function` (`function run() { create(); function create() {} }` calls the
  // file's own `create`), and a `const`, a `let` or a class in the temporal dead
  // zone that a mention of its own scope stands before. The nearest such
  // declaration wins, by the same order as a declaration that starts before it.
  const after = inScope
    .sort((left, right) =>
      containerOf(right.qualifiedName).length - containerOf(left.qualifiedName).length
      || left.range.startLine - right.range.startLine
      || left.range.startColumn - right.range.startColumn
      || byCodePoint(left.id, right.id));
  const hoisted = after[0];
  return hoisted === undefined ? undefined : { id: hoisted.id };
}

/** The symbol kinds whose members a bare name of the file reaches: a function, a method, a constructor, a module, a namespace. */
const LEXICAL_SCOPES: readonly SymbolKind[] = ['constructor', 'function', 'method', 'module', 'namespace'];

/**
 * Whether a container is a lexical scope of the file's code: the file's own
 * scope (the empty name) or a declaration whose body a mention stands in. A
 * class's, an interface's, an enum's or a struct's members are reachable through
 * the type and never by a bare name, so they shadow nothing.
 *
 * A *block* is not published: stage 3 names a declaration inside a block by the
 * function that holds it (`f.c`), so a mention outside a block may bind to a
 * declaration of another block of the same function. That is the price of
 * resolving locals at all, and it is stated in the change record.
 */
function isLexicalScope(symbols: readonly ResolutionSymbolRow[], container: string): boolean {
  if (container === '') return true;
  const holder = symbols.find((symbol) => symbol.qualifiedName === container);
  return holder !== undefined && LEXICAL_SCOPES.includes(holder.symbolKind);
}

/** The qualified name of the innermost symbol of a file that holds a place: the chain a mention stands in. */
function enclosingChain(symbols: readonly ResolutionSymbolRow[], line: number, column: number): string {
  const held = symbols.filter((symbol) => holds(symbol.range, line, column)).sort((left, right) => sizeOf(left.range) - sizeOf(right.range) || byCodePoint(left.id, right.id));
  return held[0]?.qualifiedName ?? '';
}

/** The container part of a qualified name: `Widget` for `Widget.total`, empty at the file's own scope. */
function containerOf(qualifiedName: string): string {
  const at = qualifiedName.lastIndexOf('.');
  return at < 0 ? '' : qualifiedName.slice(0, at);
}

/** The name a qualified name ends with: `total` for `Widget.total`. */
function namePartOf(qualifiedName: string): string {
  const at = qualifiedName.lastIndexOf('.');
  return at < 0 ? qualifiedName : qualifiedName.slice(at + 1);
}

/** Whether a declaration's container is a scope the mention's chain stands in: the same one, or an ancestor of it. */
function inScopeOf(chain: string, container: string): boolean {
  if (container === '') return true;
  return chain === container || chain.startsWith(`${container}.`);
}

/** Whether a declaration starts before a place: on an earlier line, or earlier in the same one. */
function startsBefore(range: FactRange, line: number, column: number): boolean {
  return range.startLine < line || (range.startLine === line && range.startColumn <= column);
}

/**
 * The innermost symbol of a file that holds a place: the smallest declaration
 * whose range contains it, which is the declaration a mention stands in.
 */
function innermostSymbol(symbols: readonly ResolutionSymbolRow[], line: number, column: number): ResolvedSymbol | undefined {
  const held = symbols
    .filter((symbol) => holds(symbol.range, line, column))
    .sort((left, right) => sizeOf(left.range) - sizeOf(right.range) || byCodePoint(left.id, right.id));
  const first = held[0];
  return first === undefined ? undefined : { id: first.id };
}

/** Whether a declaration's range holds a place: its first line and column through its last. */
function holds(range: FactRange, line: number, column: number): boolean {
  if (line < range.startLine || line > range.endLine) return false;
  if (line === range.startLine && column < range.startColumn) return false;
  if (line === range.endLine && column >= range.endColumn) return false;
  return true;
}

/** How big a range is, in lines and columns: what tells the innermost declaration of two that hold a place. */
function sizeOf(range: FactRange): number {
  return (range.endLine - range.startLine) * 1_000_000 + (range.endColumn - range.startColumn);
}

/** The edge kind one use folds into. */
const EDGE_OF_USE: Readonly<Record<string, 'call' | 'inherits' | 'reference'>> = {
  call: 'call',
  extends: 'inherits',
  implements: 'inherits',
  mention: 'reference',
};

/** The precision that wins where one relation is folded from sites resolved two ways, and the order they are read in. */
const PRECISION_RANK: Readonly<Record<ResolutionPrecision, number>> = { compiler: 0, syntactic: 1 };

/**
 * The edges a file's resolved mentions fold into: one edge per pair of symbols
 * and kind, with the count of the sites and the provenance of the smallest site
 * in the file's own order, so two runs write the same edge for the same sites.
 * A relation resolved both by a compiler and syntactically keeps the compiler's
 * precision: the stronger reading of the same two symbols is the one a reader
 * of the graph should weigh.
 */
function foldSites(sites: readonly Site[], at: (span: ExtractedResolutionMention['span']) => FactProvenance): Fact[] {
  const grouped = new Map<string, Site[]>();
  for (const site of sites) {
    const kind = EDGE_OF_USE[site.mention.use] ?? 'reference';
    const form = site.mention.use === 'extends' || site.mention.use === 'implements' ? site.mention.use as InheritsForm : '';
    const key = `${kind}\u0000${site.from}\u0000${site.to}\u0000${form}`;
    const held = grouped.get(key) ?? [];
    held.push(site);
    grouped.set(key, held);
  }
  const facts: Fact[] = [];
  for (const key of [...grouped.keys()].sort(byCodePoint)) {
    const held = grouped.get(key)!;
    const parts = key.split('\u0000');
    const kind = parts[0]!;
    const from = parts[1]!;
    const to = parts[2]!;
    const form = parts[3]!;
    const first = [...held].sort((left, right) => left.mention.span.startByte - right.mention.span.startByte || left.mention.span.endByte - right.mention.span.endByte)[0]!;
    const precision = [...held].sort((left, right) => PRECISION_RANK[left.precision] - PRECISION_RANK[right.precision])[0]!.precision;
    const provenance = at(first.mention.span);
    if (kind === 'inherits') {
      facts.push(makeEdgeFact({ kind: 'inherits', layer: 'extracted', provenance, value: { from, to, form: form as InheritsForm, precision } }));
    } else if (kind === 'call') {
      facts.push(makeEdgeFact({ kind: 'call', layer: 'extracted', provenance, value: { from, to, count: held.length, precision } }));
    } else {
      facts.push(makeEdgeFact({ kind: 'reference', layer: 'extracted', provenance, value: { from, to, count: held.length, precision } }));
    }
  }
  return facts;
}

/** The place one span stands at, in the schema's own counting of lines and columns. */
export function placeOf(path: RepositoryPath, span: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number }): FactPlace {
  return {
    file: path,
    range: {
      startLine: span.startLine,
      startColumn: span.startColumn,
      endLine: span.endLine,
      endColumn: span.endColumn,
    },
  };
}

/**
 * Every fact once, in code point order of kind and id: two runs write the same
 * set in the same order. Two facts of one kind and one id are one fact, and one
 * place a name is both read and written keeps the roles of both (the schema's
 * roles are a list, each once, in code point order). Two facts of one id that
 * say anything else are refused rather than folded in silence: one of them would
 * be lost, and nothing would say which.
 */
export function oneFactPerId(facts: readonly Fact[], path: RepositoryPath): Fact[] {
  const byId = new Map<string, Fact>();
  for (const fact of facts) {
    const key = `${fact.kind}\u0000${fact.id}`;
    const held = byId.get(key);
    if (held === undefined) {
      byId.set(key, fact);
      continue;
    }
    const merged = mergeRoles(held, fact);
    if (merged !== undefined) {
      byId.set(key, merged);
      continue;
    }
    throw new Error(`two ${fact.kind} facts of ${path} share the id ${fact.id} and say different things: one stands at ${placeOfFact(held)}, the other at ${placeOfFact(fact)}`);
  }
  return [...byId.keys()].sort(byCodePoint).map((key) => byId.get(key)!);
}

/** Where a fact stands, as a refusal names it: `path:line:column`, or "no place" where it cites none. */
function placeOfFact(fact: Fact): string {
  const place = fact.provenance.place;
  if (place === undefined) return 'no place';
  return `${place.file}:${place.range.startLine}:${place.range.startColumn}`;
}

/** Two occurrences at one place, with the roles of both; `undefined` for anything else. */
function mergeRoles(held: Fact, fact: Fact): Fact | undefined {
  if (held.kind !== 'occurrence' || fact.kind !== 'occurrence') return undefined;
  const one = held.value as { readonly symbol: string; readonly roles: readonly string[] };
  const other = fact.value as { readonly symbol: string; readonly roles: readonly string[] };
  if (one.symbol !== other.symbol) return undefined;
  return { ...held, value: { symbol: one.symbol, roles: [...new Set([...one.roles, ...other.roles])].sort(byCodePoint) } } as Fact;
}

/** The gaps one `what` once, in code point order of `what`, as the schema reads a coverage's list. */
function mergeGaps(gaps: readonly CoverageGap[]): CoverageGap[] {
  const byWhat = new Map<string, CoverageGap>();
  for (const gap of gaps) if (!byWhat.has(gap.what)) byWhat.set(gap.what, gap);
  return [...byWhat.keys()].sort(byCodePoint).map((what) => byWhat.get(what)!);
}
