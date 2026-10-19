/**
 * What one file's resolution becomes (madarch-tzte.21.6): the `occurrence` of
 * each mention the file makes, the `call`, `reference` and `inherits` edges
 * those mentions fold into, and the file's `coverage` — what was read and what
 * could not be.
 *
 * **What the resolver resolves.** A mention names a symbol of this repository
 * when the name is bound
 *
 * 1. by a declaration of the file the mention stands in — the nearest
 *    declaration whose own span holds the mention, else a top-level one, both
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
import { resolveSpecifier } from './syntax-facts.js';
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
  /** Whether a compiler's index of this repository answered at all: named in the coverage where it did not. */
  readonly indexAvailable: boolean;
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

  // The bindings the file's imports make, and the file each one names.
  const bindings = new Map<string, Binding>();
  for (const entry of request.findings.imports) {
    const target = resolveSpecifier(request.path, entry.specifier, known);
    if (target === undefined) {
      // A package outside the repository, or a specifier that names no file of
      // it: the graph holds no symbol of that module, so the import is named
      // once here rather than leaving each of its uses a wrong edge.
      unread.push({
        what: `${request.path} imports "${entry.specifier}", whose symbols are not in this repository`,
        reason: 'unsupported',
      });
      continue;
    }
    bindings.set(entry.local, { target, imported: entry.imported });
  }

  for (const mention of request.findings.mentions) {
    if (mention.parameterBound) continue;
    const key = `${mention.span.startLine}:${mention.span.startColumn}`;
    const fromIndex = request.index.get(key);
    // The caller: the innermost symbol of this file whose own span holds the
    // mention. An edge names two symbols, and a mention standing in no symbol
    // of the file has no caller to name.
    const caller = innermostSymbol(request.fileSymbols, mention.span.startLine, mention.span.startColumn);
    let target: { id: string; file: string } | undefined;
    let precision: ResolutionPrecision = 'syntactic';
    if (fromIndex !== undefined) {
      target = { id: fromIndex, file: 'the compiler index' };
      precision = 'compiler';
    } else {
      const tied = bindMention(request, mention, bindings);
      if (tied.kind === 'resolved') target = tied.symbol;
      else if (tied.kind === 'out-of-claim') continue;
      else {
        unresolved += 1;
        unread.push({ what: `${mention.name} at ${request.path}:${mention.span.startLine}:${mention.span.startColumn}, ${tied.why}`, reason: 'unsupported' });
        continue;
      }
    }
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

  // The compiler's index, named when this run has none: the resolution above is
  // the syntactic fallback, and a reader of the file's coverage sees that no
  // compiler answered for it.
  if (!request.indexAvailable && request.findings.parsed) {
    unread.push({
      what: 'a compiler index of the repository (a SCIP indexer), which resolves a name the syntax cannot bind',
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
    facts: sortedFacts(facts),
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

/** What an import binds in a file: the file it names, and what of that file the name stands for. */
interface Binding {
  readonly target: string;
  readonly imported: ExtractedFileResolution['imports'][number]['imported'];
}

/** What binding a mention answered: a symbol, a claim this resolver does not make, or a failure with its reason. */
type BoundMention =
  | { readonly kind: 'resolved'; readonly symbol: { id: string; file: string } }
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
    const binding = bindings.get(mention.through);
    if (binding === undefined || binding.imported.form !== 'namespace') return { kind: 'out-of-claim' };
    const symbol = topLevelSymbol(symbolsOf(request, binding.target), mention.name);
    if (symbol === undefined) {
      return { kind: 'unresolved', why: `the file ${binding.target} declares no ${JSON.stringify(mention.name)} the namespace names` };
    }
    return { kind: 'resolved', symbol };
  }
  const declared = innermostSymbol(request.fileSymbols, mention.span.startLine, mention.span.startColumn, mention.name)
    ?? topLevelSymbol(request.fileSymbols, mention.name);
  if (declared !== undefined) return { kind: 'resolved', symbol: declared };
  const binding = bindings.get(mention.name);
  if (binding === undefined) return { kind: 'out-of-claim' };
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
function topLevelSymbol(symbols: readonly ResolutionSymbolRow[], name: string): { id: string; file: string } | undefined {
  const held = symbols
    .filter((symbol) => symbol.qualifiedName === name)
    .sort((left, right) => byCodePoint(left.id, right.id));
  const first = held[0];
  return first === undefined ? undefined : { id: first.id, file: first.file };
}

/**
 * The innermost symbol of a file that holds a place: the smallest declaration
 * whose range contains it, which is the declaration a mention stands in. Named,
 * it is the declaration of that name holding the place (`f.inner` for a
 * mention of `inner` inside `f`); unnamed, it is the caller of a call.
 */
function innermostSymbol(symbols: readonly ResolutionSymbolRow[], line: number, column: number, name?: string): { id: string; file: string } | undefined {
  const held = symbols
    .filter((symbol) => holds(symbol.range, line, column))
    .filter((symbol) => name === undefined || symbol.qualifiedName.split('.').pop() === name)
    .sort((left, right) => sizeOf(left.range) - sizeOf(right.range) || byCodePoint(left.id, right.id));
  const first = held[0];
  return first === undefined ? undefined : { id: first.id, file: first.file };
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

/** Every fact once, in code point order of kind and id: two runs write the same set in the same order. */
function sortedFacts(facts: readonly Fact[]): Fact[] {
  const byId = new Map<string, Fact>();
  for (const fact of facts) byId.set(`${fact.kind}\u0000${fact.id}`, fact);
  return [...byId.keys()].sort(byCodePoint).map((key) => byId.get(key)!);
}

/** The gaps one `what` once, in code point order of `what`, as the schema reads a coverage's list. */
function mergeGaps(gaps: readonly CoverageGap[]): CoverageGap[] {
  const byWhat = new Map<string, CoverageGap>();
  for (const gap of gaps) if (!byWhat.has(gap.what)) byWhat.set(gap.what, gap);
  return [...byWhat.keys()].sort(byCodePoint).map((what) => byWhat.get(what)!);
}
