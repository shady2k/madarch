/**
 * What the code pass makes of the library's records (decision 0033's "The code
 * pass"): one table from the library's vocabulary to ours, the join of the
 * library's declarations to the records the per-file passes published, and the
 * edges it writes.
 *
 * **The mapping is data.** `NODE_TIES` and `EDGE_TIES` are the whole of it: a
 * library kind is either tied to one of our kinds or listed as a kind with no
 * honest counterpart, which stays out and is counted in the run's coverage. No
 * pattern of a repository is read here — nothing looks at a path, a name or a
 * framework to decide what a record is.
 *
 * **What the stage takes, and what it leaves to the per-file passes.** Measured
 * against the training reference and against a second repository
 * (`/work/out/report-codegraph.md`), the per-file passes state fields, files
 * and test cases at least as well as the library does, and the library states
 * calls better than the resolution pass did. So this stage writes the links the
 * library resolved — calls (a constructor call included, as the reference states
 * it), references, implementations and inheritances — and no symbol, file,
 * field or test record, with one exception: a symbol in a file no per-file pass
 * of ours can read (a language our grammars do not hold) is written here,
 * because no other pass could state it.
 *
 * **The join is by place.** A library declaration carries the file, line and
 * column it stands at; a published symbol carries the span it was read at. The
 * library's own line numbers are the only place it states, so a declaration is
 * joined to the published record that starts on its line with its name, else to
 * the one record of that name whose span holds its line. A declaration no
 * published record answers is counted as unresolved: the edge that names it is
 * not written on a guess, and the run's coverage names how many were left.
 */
import { byCodePoint } from '../../model/order.js';
import { FACT_KINDS, type CoverageGap } from '../facts.js';
import type { StageDraftWrite } from '../stage.js';

/** The library's version, as the stage pins it: what a record's provenance names. */
export const CODEGRAPH_LIBRARY_VERSION = '1.6.2';

// ---- the library's own records -------------------------------------------

/** One node the library published: its identity, its kind, its name and the place it stands at. */
export interface LibraryNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName: string;
  /** The path from the index root the node was read under. */
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

/** One edge the library published, with the marks it resolved it by. */
export interface LibraryEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly line?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** One index run: the folder it stood at, and what it answered. */
export interface LibraryRun {
  /** The folder the library indexed, from the repository's root (`''` for the root itself). */
  readonly root: string;
  readonly module: string | undefined;
  readonly nodes: readonly LibraryNode[];
  readonly edges: readonly LibraryEdge[];
  /** The files the library indexed, as the folder's own paths. */
  readonly indexed: readonly string[];
  /** The files the library walked and did not read, with the reason it gave. */
  readonly skipped: readonly { readonly path: string; readonly why: string }[];
  readonly wallMs: number;
  readonly processPeakRssBytes: number;
  readonly libraryDurationMs: number | undefined;
}

/** Every index run of one repository, in the order they ran. */
export interface LibraryIndex {
  readonly runs: readonly LibraryRun[];
  /** The folders that hold a `go.mod` of the tree, from the repository's root, in code point order. */
  readonly moduleRoots: readonly string[];
  readonly wallMs: number;
  readonly processPeakRssBytes: number;
}

// ---- the table ------------------------------------------------------------

/**
 * The library's node kinds, tied to ours: a kind becomes a record of that kind
 * only in a file no per-file pass of ours reads (see the module's header), and
 * a kind with no tie is left out and counted.
 */
export const NODE_TIES: Readonly<Record<string, { readonly kind: string; readonly symbolKind: string }>> = {
  class: { kind: 'code.symbol', symbolKind: 'class' },
  component: { kind: 'code.symbol', symbolKind: 'component' },
  constant: { kind: 'code.symbol', symbolKind: 'constant' },
  enum: { kind: 'code.symbol', symbolKind: 'enum' },
  enum_member: { kind: 'code.symbol', symbolKind: 'enum-member' },
  function: { kind: 'code.symbol', symbolKind: 'function' },
  interface: { kind: 'code.symbol', symbolKind: 'interface' },
  method: { kind: 'code.symbol', symbolKind: 'method' },
  protocol: { kind: 'code.symbol', symbolKind: 'protocol' },
  struct: { kind: 'code.symbol', symbolKind: 'struct' },
  trait: { kind: 'code.symbol', symbolKind: 'trait' },
  type_alias: { kind: 'code.symbol', symbolKind: 'type-alias' },
  union: { kind: 'code.symbol', symbolKind: 'union' },
  variable: { kind: 'code.symbol', symbolKind: 'variable' },
};

/**
 * The node kinds of the library that stay out, and why. A `field` or `property`
 * is read by the per-file pass of the file's own bytes (the code-facts stage),
 * which states Go struct fields the library does not read; a `file` is the
 * inventory's; an `import` node is not a record of ours (an import is an edge);
 * an `export` list, a `parameter`, a `module` and a `namespace` have no kind of
 * ours either.
 */
export const NODE_KINDS_OUT: readonly { readonly kind: string; readonly why: string }[] = [
  { kind: 'export', why: 'our graph states no export list: the export is a property of the record it names' },
  { kind: 'field', why: 'the per-file pass of the file states its fields, Go struct fields included, and states them at least as well (measured)' },
  { kind: 'file', why: 'the inventory states every file of the tree, code and non-code alike, and states them at least as well (measured)' },
  { kind: 'import', why: 'an import is a relation of ours, never a node: the file pass writes the file-to-file import edge' },
  { kind: 'module', why: 'our module is the clustering stage\'s record of a folder\'s members, not a namespace of declarations' },
  { kind: 'namespace', why: 'a namespace is no kind of our vocabulary' },
  { kind: 'parameter', why: 'a parameter is a field of a callable\'s signature in the fact schema, not a record' },
  { kind: 'property', why: 'the per-file pass of the file states its fields, and states them at least as well (measured)' },
  { kind: 'route', why: 'the operations reading states the routes of the code it reads, with the handler each reaches; the library states a router-relative path without the mount it is registered under' },
];

/** One relation of the library, tied to ours: the relation, the fact kind it is written as, and the form where our vocabulary tells two apart. */
export interface EdgeTie {
  readonly relation: string;
  readonly factKind: 'call' | 'reference' | 'inherits';
  readonly form?: 'extends' | 'implements';
}

/**
 * The library's edge kinds, tied to our relations. `instantiates` is a
 * constructor call and our reference states one as a call; `implements` is an
 * interface-to-implementation link and is never a call, although the library
 * synthesizes those links as edges of its `calls` kind (they are told apart by
 * their `synthesizedBy` mark, not by their kind).
 */
export const EDGE_TIES: Readonly<Record<string, EdgeTie>> = {
  calls: { relation: 'code.calls', factKind: 'call' },
  extends: { relation: 'code.inherits', factKind: 'inherits', form: 'extends' },
  implements: { relation: 'code.implements', factKind: 'inherits', form: 'implements' },
  instantiates: { relation: 'code.calls', factKind: 'call' },
  references: { relation: 'code.references', factKind: 'reference' },
};

/** The edge kinds of the library that stay out, and why. */
export const EDGE_KINDS_OUT: readonly { readonly kind: string; readonly why: string }[] = [
  { kind: 'contains', why: 'the file pass already writes the containment of a file and its declarations, and one edge has one producer' },
  { kind: 'decorates', why: 'a decorator is no relation of our vocabulary' },
  { kind: 'exports', why: 'our graph states no export relation' },
  { kind: 'imports', why: 'the file pass writes the file-to-file import edge; the library also names a file-to-symbol import, which is another fact' },
  { kind: 'navigates', why: 'a navigation is no relation of our vocabulary' },
  { kind: 'overrides', why: 'an override is no relation of our vocabulary; the inheritance is stated by `extends` and `implements`' },
  { kind: 'returns', why: 'a declared return type is a field of a signature in the fact schema, not an edge' },
  { kind: 'type_of', why: 'a declared type is a field of a declaration in the fact schema, not an edge' },
];

/** The fact kinds the stage produces: the three links, its coverage, and the symbols of a file no per-file pass reads. */
export const CODEGRAPH_EDGE_FACT_KINDS: readonly string[] = ['call', 'inherits', 'reference'];

/** The schema version each produced fact kind is written in. */
export function codegraphProduces(): readonly { readonly kind: string; readonly schemaVersion: number; readonly scope: 'repository' }[] {
  return ['call', 'coverage', 'inherits', 'reference', 'symbol'].map((kind) => ({
    kind,
    schemaVersion: FACT_KINDS[kind as 'call'].version,
    scope: 'repository' as const,
  }));
}

// ---- the published records the join stands on -----------------------------

/** One symbol the per-file passes published, as the join reads it: its key, its place and its name. */
export interface PublishedSymbol {
  readonly key: string;
  readonly file: string;
  readonly qualifiedName: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The simple name a qualified name ends with: `A.b` and `A::b` both name `b`. */
export function simpleNameOf(qualifiedName: string): string {
  const cut = Math.max(qualifiedName.lastIndexOf('.'), qualifiedName.lastIndexOf('::'));
  return cut < 0 ? qualifiedName : qualifiedName.slice(cut === qualifiedName.lastIndexOf('::') ? cut + 2 : cut + 1);
}

/** The qualified name a library node carries, without the path the library prefixes it with. */
function qualifiedNameOf(node: LibraryNode): string {
  const prefix = `${node.filePath}::`;
  return node.qualifiedName.startsWith(prefix) ? node.qualifiedName.slice(prefix.length) : node.name;
}

/** The repository path of a library node read under one index root. */
function repositoryPathOf(node: LibraryNode, root: string): string {
  return root === '' ? node.filePath : `${root}/${node.filePath}`;
}

/** The files this stage leaves to the per-file passes: every path a grammar of ours reads. */
export interface JoinInput {
  readonly repository: string;
  readonly commit: string;
  readonly index: LibraryIndex;
  /** The symbols the per-file passes published, in code point order of their keys. */
  readonly published: readonly PublishedSymbol[];
  /** Whether a per-file pass of ours can read this path at all. */
  readonly readByFill: (path: string) => boolean;
}

/** One mark an edge carries: how the library obtained it and how far it trusts it. */
interface EdgeMark {
  readonly resolvedBy: string;
  readonly confidence: number | undefined;
  readonly count: number;
}

/** One edge the stage writes, with the library's own kind and marks for the report. */
export interface JoinedEdge {
  readonly relation: string;
  readonly factKind: string;
  readonly form?: string;
  readonly from: string;
  readonly to: string;
  readonly libraryKind: string;
  readonly marks: readonly EdgeMark[];
  readonly count: number;
  readonly resolvedBy: string;
  readonly confidence: number | undefined;
  /** The line of the first site the library named, where it named one. */
  readonly line: number | undefined;
}

/** What one repository's join found: the nodes it adds, the edges it writes, and what it could not tie. */
export interface JoinResult {
  readonly nodes: readonly JoinedNode[];
  readonly edges: readonly JoinedEdge[];
  /** The library's records by the reason they were left out, in code point order of the reason. */
  readonly left: readonly { readonly what: string; readonly count: number }[];
  readonly symbolsJoined: number;
  readonly symbolsUnresolved: number;
}

/** One node the stage adds: a symbol of a file no per-file pass of ours reads. */
interface JoinedNode {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly file: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** The index of the published symbols the join asks: by place, by line and by name. */
interface SymbolIndex {
  readonly byPlace: ReadonlyMap<string, string>;
  readonly byLine: ReadonlyMap<string, readonly PublishedSymbol[]>;
  readonly byName: ReadonlyMap<string, readonly PublishedSymbol[]>;
}

const placeKey = (file: string, line: number, name: string): string => `${file}\u0000${String(line)}\u0000${name}`;
const lineKey = (file: string, line: number): string => `${file}\u0000${String(line)}`;
const nameKey = (file: string, name: string): string => `${file}\u0000${name}`;

/** The three lookups the join makes of the published symbols, each built once. */
function symbolIndexOf(published: readonly PublishedSymbol[]): SymbolIndex {
  const byPlace = new Map<string, string>();
  const byLine = new Map<string, PublishedSymbol[]>();
  const byName = new Map<string, PublishedSymbol[]>();
  for (const symbol of published) {
    const name = simpleNameOf(symbol.qualifiedName);
    const place = placeKey(symbol.file, symbol.startLine, name);
    if (!byPlace.has(place)) byPlace.set(place, symbol.key);
    const line = lineKey(symbol.file, symbol.startLine);
    (byLine.get(line) ?? byLine.set(line, []).get(line)!).push(symbol);
    const named = nameKey(symbol.file, name);
    (byName.get(named) ?? byName.set(named, []).get(named)!).push(symbol);
  }
  return { byPlace, byLine, byName };
}

/** The published symbol a library declaration stands for, by the library's own place and name. */
function joinedSymbol(index: SymbolIndex, node: LibraryNode, path: string): PublishedSymbol | undefined {
  const name = node.name;
  const exact = index.byPlace.get(placeKey(path, node.startLine, name));
  if (exact !== undefined) return { key: exact, file: path, qualifiedName: name, startLine: node.startLine, endLine: node.startLine };
  const onLine = (index.byLine.get(lineKey(path, node.startLine)) ?? []).filter((symbol) => simpleNameOf(symbol.qualifiedName) === name);
  if (onLine.length === 1) return onLine[0]!;
  if (onLine.length > 1) return undefined;
  // A declaration whose start line our pass counted another way (a signature that
  // opens above the name): the innermost record of that name whose span holds the
  // library's line, and only where exactly one does.
  const byName = (index.byName.get(nameKey(path, name)) ?? []).filter((symbol) => symbol.startLine <= node.startLine && node.startLine <= symbol.endLine);
  if (byName.length === 0) return undefined;
  const innermost = [...byName].sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine) || byCodePoint(left.key, right.key))[0]!;
  const tied = byName.filter((symbol) => symbol.endLine - symbol.startLine === innermost.endLine - innermost.startLine);
  return tied.length === 1 ? innermost : undefined;
}
// ---- the join ------------------------------------------------------------

/**
 * What one repository's library runs become: the nodes the stage adds, the
 * edges it writes, and every library record it left out, by reason.
 *
 * **One source per file.** The library is run once per module root (the folder
 * that holds a `go.mod`), and the same file is indexed by its module's run and
 * by a parent's. The deepest module root that holds a file is the run its
 * records are taken from, so a record is read once and no two runs' nodes of one
 * declaration compete.
 *
 * **No edge on a guess.** An end the published records do not answer is not
 * written: the library's line numbers meet the published spans, and a
 * declaration they do not tie is counted, never joined to the nearest name.
 */
export function codegraphJoin(input: JoinInput): JoinResult {
  const { repository, commit, index } = input;
  const roots = [...index.moduleRoots].sort((left, right) => (right.length - left.length) || byCodePoint(left, right));
  const ownerOf = (path: string): string => {
    for (const root of roots) {
      if (root === '' || path === root || path.startsWith(`${root}/`)) return root;
    }
    return '';
  };
  const symbols = symbolIndexOf(input.published);
  /** The library node's key in our graph, once the join or the gap-fill answered one. */
  const keys = new Map<string, string>();
  const nodes: JoinedNode[] = [];
  const publishedKeys = new Set(input.published.map((symbol) => symbol.key));
  const left = new Map<string, number>();
  const countLeft = (what: string): void => { left.set(what, (left.get(what) ?? 0) + 1); };
  let symbolsJoined = 0;
  let symbolsUnresolved = 0;
  const edges: JoinedEdge[] = [];
  const folded = new Map<string, { relation: string; factKind: string; form?: string; from: string; to: string; libraryKind: string; marks: EdgeMark[]; line: number | undefined }>();

  for (const run of index.runs) {
    for (const node of run.nodes) {
      const path = repositoryPathOf(node, run.root);
      if (ownerOf(path) !== run.root) continue;
      const tie = Object.prototype.hasOwnProperty.call(NODE_TIES, node.kind) ? NODE_TIES[node.kind] : undefined;
      if (tie === undefined) continue;
      const held = joinedSymbol(symbols, node, path);
      if (held !== undefined) {
        keys.set(node.id, held.key);
        symbolsJoined += 1;
        continue;
      }
      if (!input.readByFill(path)) {
        // A file no per-file pass of ours can read: this is the one record the
        // stage writes as a node (see the module's header).
        const qualifiedName = qualifiedNameOf(node);
        const key = `code.symbol:${path}#${qualifiedName}`;
        if (publishedKeys.has(key)) {
          keys.set(node.id, key);
          symbolsJoined += 1;
          continue;
        }
        publishedKeys.add(key);
        nodes.push({
          key,
          kind: tie.kind,
          label: qualifiedName,
          file: path,
          properties: {
            repository,
            file: path,
            qualifiedName,
            symbolKind: tie.symbolKind,
            globalName: `${repository}:${path}#${qualifiedName}`,
            factKind: 'symbol',
            layer: 'extracted',
            status: 'proposed',
            provenance: {
              source: { system: 'codegraph', version: CODEGRAPH_LIBRARY_VERSION },
              repository: { id: repository, commit },
              place: {
                file: path,
                range: {
                  startLine: node.startLine, startColumn: node.startColumn,
                  endLine: node.endLine, endColumn: node.endColumn,
                },
              },
              pass: 'codegraph',
              libraryKind: node.kind,
            },
            pass: 'codegraph',
            libraryKind: node.kind,
          },
        });
        keys.set(node.id, key);
        symbolsJoined += 1;
        continue;
      }
      symbolsUnresolved += 1;
      countLeft(`a ${node.kind} no published record stands at: ${path}`);
    }
    for (const edge of run.edges) {
      const synthesized = typeof edge.metadata['synthesizedBy'] === 'string' ? edge.metadata['synthesizedBy'] as string : undefined;
      if (synthesized === 'http-client' || edge.metadata['channel'] === 'http') {
        countLeft('an http-client link from a client call to a server route');
        continue;
      }
      const tie = synthesized === 'interface-impl'
        ? { relation: 'code.implements', factKind: 'inherits' as const, form: 'implements' as const }
        : (Object.prototype.hasOwnProperty.call(EDGE_TIES, edge.kind) ? EDGE_TIES[edge.kind] : undefined);
      if (tie === undefined) {
        countLeft(`a relation of the library no relation of ours states: ${edge.kind}`);
        continue;
      }
      const from = keys.get(edge.source);
      const to = keys.get(edge.target);
      if (from === undefined || to === undefined) {
        countLeft(`${edge.kind} left without an end: ${from === undefined ? 'the source' : 'the target'} is no record of ours`);
        continue;
      }
      const identity = `${tie.relation}\u0000${from}\u0000${to}\u0000${tie.form ?? ''}`;
      const held = folded.get(identity) ?? { relation: tie.relation, factKind: tie.factKind, ...(tie.form === undefined ? {} : { form: tie.form }), from, to, libraryKind: edge.kind, marks: [], line: undefined };
      const resolvedBy = typeof edge.metadata['resolvedBy'] === 'string' ? edge.metadata['resolvedBy'] as string : 'synthesized';
      const confidence = typeof edge.metadata['confidence'] === 'number' ? edge.metadata['confidence'] as number : undefined;
      const at = held.marks.findIndex((candidate) => candidate.resolvedBy === resolvedBy && candidate.confidence === confidence);
      if (at < 0) held.marks.push({ resolvedBy, confidence, count: 1 });
      else held.marks[at] = { ...held.marks[at]!, count: held.marks[at]!.count + 1 };
      if (held.line === undefined && typeof edge.line === 'number') held.line = edge.line;
      folded.set(identity, held);
    }
  }

  for (const held of [...folded.values()]) {
    // The strongest mark names the edge's own `resolvedBy` and confidence: the
    // reading the library trusted most, with code point order breaking a tie so
    // two runs write the same edge.
    const marks = [...held.marks].sort((left, right) => (right.confidence ?? -1) - (left.confidence ?? -1) || byCodePoint(left.resolvedBy, right.resolvedBy));
    const strongest = marks[0]!;
    edges.push({
      relation: held.relation,
      factKind: held.factKind,
      ...(held.form === undefined ? {} : { form: held.form }),
      from: held.from,
      to: held.to,
      libraryKind: held.libraryKind,
      marks,
      count: marks.reduce((total, mark) => total + mark.count, 0),
      resolvedBy: strongest.resolvedBy,
      confidence: strongest.confidence,
      line: held.line,
    });
  }
  const leftRows = [...left.entries()].map(([what, count]) => ({ what, count })).sort((one, other) => byCodePoint(one.what, other.what));
  return {
    nodes: nodes.sort((one, other) => byCodePoint(one.key, other.key)),
    edges: edges.sort((one, other) => byCodePoint(`${one.relation} ${one.from} ${one.to}`, `${other.relation} ${other.from} ${other.to}`)),
    left: leftRows,
    symbolsJoined,
    symbolsUnresolved,
  };
}

/** The provenance every edge of the pass carries: the library, its version and the pass's own name. */
function edgeProvenanceOf(repository: string, commit: string): Readonly<Record<string, unknown>> {
  return {
    source: { system: 'codegraph', version: CODEGRAPH_LIBRARY_VERSION },
    repository: { id: repository, commit },
    pass: 'codegraph',
  };
}

/** One joined edge as a draft write of the graph's own shape, with the library's marks as properties. */
export function edgeWriteOf(edge: JoinedEdge, repository: string, commit: string, evidence: string): StageDraftWrite {
  return {
    kind: 'edge',
    evidence,
    value: {
    relation: edge.relation,
    from: { key: edge.from },
    to: { key: edge.to },
    properties: {
      provenance: edgeProvenanceOf(repository, commit),
      pass: 'codegraph',
      repository,
      factKind: edge.factKind,
      ...(edge.form === undefined ? {} : { form: edge.form }),
      libraryKind: edge.libraryKind,
      resolvedBy: edge.resolvedBy,
      ...(edge.confidence === undefined ? {} : { confidence: edge.confidence }),
      count: edge.count,
      marks: edge.marks.map((mark) => ({ resolvedBy: mark.resolvedBy, count: mark.count, ...(mark.confidence === undefined ? {} : { confidence: mark.confidence }) })),
      ...(edge.line === undefined ? {} : { line: edge.line }),
    },
    },
  };
}

/** Every gap the run's coverage names: what the library could not read, and what the join could not tie. */
export function gapsOf(index: LibraryIndex, joined: JoinResult): readonly CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const run of index.runs) {
    for (const skipped of run.skipped) {
      gaps.push({ what: `${skipped.path}: ${skipped.why}`, reason: skipped.why === 'unsupported' ? 'unsupported' : 'inaccessible' });
    }
  }
  for (const left of joined.left) gaps.push({ what: `${left.what} (${String(left.count)})`, reason: 'unsupported' });
  if (joined.symbolsUnresolved > 0) gaps.push({ what: `${String(joined.symbolsUnresolved)} declarations of the library no published record stands at`, reason: 'inaccessible' });
  return gaps.sort((one, other) => byCodePoint(one.what, other.what) || byCodePoint(one.reason, other.reason));
}
