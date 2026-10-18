/**
 * What the syntax stage's per-file findings become (madarch-tzte.21.3; the
 * fact schema of madarch-tzte.20.1): the facts of one file, each with its
 * place, its layer and the id `src/fill/facts.ts` computes from what the fact
 * is about — never from a machine path, a run, a unit or a time.
 *
 * One file's findings make:
 *
 * - a `symbol` fact per declaration, and a `defines` edge from the file to it;
 * - an `occurrence` fact per declaration at the name it defines, with the one
 *   role `definition`, which is what this stage's tree gives (the finer roles
 *   are stage 4's, decision 0026);
 * - a `comment` fact per comment, with the text a later stage reads intent from;
 * - an `entry-point` fact per way into the code the file declares: a `main`, a
 *   command, a route, or a top-level export another module may call;
 * - a `test` fact per test the file declares, by the name its runner knows;
 * - an `import` edge per specifier this stage can tie to a file of the same
 *   repository — the schema's own rule: an import it cannot tie to a node is
 *   the scope's coverage gap, never an edge with an invented end;
 * - one `coverage` fact for the file: what was read, and every gap with its
 *   reason. A file no grammar of this stage reads, bytes that are not UTF-8
 *   text, a file the parser could not read whole and a specifier that names no
 *   file are all named here — nothing is dropped in silence.
 *
 * The module is pure: it reads its request and nothing else, and the same
 * request answers the same facts with the same ids.
 */
import { posix } from 'node:path';
import { byCodePoint } from '../../model/order.js';
import {
  factId, makeEdgeFact, makeNodeFact, FACT_KINDS, repositoryPath,
  type CommentValue, type CoverageGap, type CoverageValue, type Fact, type FactPlace, type FactProvenance, type FactSource,
  type ImportEdgeValue, type RepositoryPath,
} from '../facts.js';
import { SYNTAX_EXTENSIONS, type ExtractedFileSyntax, type SyntaxSpan } from './syntax-extract.js';

/**
 * What the facts of one file stand on: the grammar's own reader. The version is
 * the runtime's, which is what a reader compares when it asks what read a fact;
 * the grammars themselves arrive with `tree-sitter-wasms` and are the four the
 * landed walk read (`src/product/fill-index.ts`).
 */
export const SYNTAX_SOURCE: FactSource = { system: 'tree-sitter', version: '0.25.10' };

/** The extension a run of source files is recognised by: the grammars this stage reads (code point order). */
const SOURCE_EXTENSIONS: readonly string[] = SYNTAX_EXTENSIONS;

/** One file's findings, and the repository they were read in. */
export interface SyntaxFactRequest {
  /** The product's own name for the repository, as the facts carry it. */
  readonly repository: string;
  /** The commit the bytes were read at: 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /** The file's repository path. */
  readonly path: RepositoryPath;
  /** What the extraction found in the file. */
  readonly findings: ExtractedFileSyntax;
  /**
   * Every file path the pinned tree of the repository holds, so an import's
   * specifier is tied to a file node that exists. The tree's own paths are what
   * a specifier is checked against: the resolution is syntactic, and the file
   * facts the edges name are published by the inventory stage of the same run.
   */
  readonly files: readonly string[];
  /** The reader the facts stand on; `SYNTAX_SOURCE` where a caller names none. */
  readonly source?: FactSource;
}

/** One file's facts, and the coverage the file was read with. */
export interface SyntaxFactSet {
  /** Every fact the file's findings make, in code point order of kind and id. */
  readonly facts: readonly Fact[];
  /** The file's coverage: what was read, and every gap with its reason. */
  readonly coverage: CoverageValue;
}

/** The facts one file's findings make, with the coverage it was read with. */
export function syntaxFacts(request: SyntaxFactRequest): SyntaxFactSet {
  const source = request.source ?? SYNTAX_SOURCE;
  const repository = { id: request.repository, commit: request.commit };
  const at = (span: SyntaxSpan): FactProvenance => ({
    source,
    repository,
    place: placeOf(request.path, span),
  });
  const facts: Fact[] = [];
  const gaps: CoverageGap[] = [...request.findings.unread];
  const known = new Set<string>(request.files);
  const fileId = fileFactIdOf(request.repository, request.path);

  for (const symbol of request.findings.symbols) {
    const symbolFact = makeNodeFact({
      kind: 'symbol',
      layer: 'extracted',
      provenance: at(symbol.span),
      value: {
        repository: request.repository,
        file: request.path,
        qualifiedName: symbol.qualifiedName,
        symbolKind: symbol.symbolKind,
      },
    });
    facts.push(symbolFact);
    facts.push(makeEdgeFact({
      kind: 'defines',
      layer: 'extracted',
      provenance: at(symbol.span),
      value: { from: fileId, to: symbolFact.id },
    }));
    facts.push(makeNodeFact({
      kind: 'occurrence',
      layer: 'extracted',
      // The occurrence stands where the name is written, which is what makes it
      // the definition of that symbol and not a mention of it.
      provenance: at(symbol.definitionSpan),
      value: { symbol: symbolFact.id, roles: ['definition'] },
    }));
  }

  for (const comment of request.findings.comments) {
    const value: CommentValue = { text: comment.text, form: comment.form };
    facts.push(makeNodeFact({ kind: 'comment', layer: 'extracted', provenance: at(comment.span), value }));
  }

  for (const entry of request.findings.entryPoints) {
    facts.push(makeNodeFact({
      kind: 'entry-point',
      layer: 'extracted',
      provenance: at(entry.span),
      value: { repository: request.repository, file: request.path, name: entry.name, form: entry.form },
    }));
  }

  for (const test of request.findings.tests) {
    facts.push(makeNodeFact({
      kind: 'test',
      layer: 'extracted',
      provenance: at(test.span),
      value: {
        repository: request.repository,
        file: request.path,
        name: test.name,
        ...(test.framework === undefined ? {} : { framework: test.framework }),
      },
    }));
  }

  // The imports: a specifier this stage can tie to a file of this repository is
  // an edge between two nodes that exist; anything else is a gap of this
  // scope, with the reason, since an invented end is worse than a named gap.
  const edges = new Map<string, Fact>();
  for (const imported of request.findings.imports) {
    const target = resolveSpecifier(request.path, imported.specifier, known);
    if (target === undefined) {
      gaps.push({ what: imported.specifier, reason: 'unsupported' });
      continue;
    }
    const value: ImportEdgeValue = { from: fileId, to: fileFactIdOf(request.repository, target), specifier: imported.specifier };
    const edge = makeEdgeFact({ kind: 'import', layer: 'extracted', provenance: at(imported.span), value });
    edges.set(edge.id, edge);
  }
  facts.push(...edges.values());

  const unread = dedupeGaps(gaps);
  const coverage: CoverageValue = {
    repository: request.repository,
    scope: request.path,
    complete: unread.length === 0,
    read: request.findings.parsed ? [request.path] : [],
    unread,
  };
  facts.push(makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source, repository },
    value: coverage,
  }));

  return { facts: sortedFacts(facts), coverage };
}

/**
 * The id of a file's `file` fact, read from the two parts that make up what a
 * file fact is: the repository and the path. The schema's rule is that an id is
 * the digest of what a fact is about and of nothing else (`FACT_KINDS.file`),
 * so a stage that knows a file's repository and path knows the id of the fact
 * the inventory stage published for it, whatever its roles, its language, its
 * size or the blob its bytes stand under — none of those is what a file is. The
 * edges this stage writes name that id; a write path that checks the nodes its
 * edges name (0026, madarch-tzte.20.4) refuses it loudly if the two ever drift
 * apart, rather than joining a file that is not there.
 */
export function fileFactIdOf(repository: string, path: string): string {
  return factId({
    kind: 'file',
    value: { repository, path: repositoryPath(path), roles: ['source'] },
    provenance: { source: SYNTAX_SOURCE, repository: { id: repository, commit: '0'.repeat(40) } },
  });
}

/** The place one finding stands at: the repository path and the range a reader counts lines and columns in. */
export function placeOf(path: RepositoryPath, span: SyntaxSpan): FactPlace {
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
function dedupeGaps(gaps: readonly CoverageGap[]): CoverageGap[] {
  const byWhat = new Map<string, CoverageGap>();
  for (const gap of gaps) if (!byWhat.has(gap.what)) byWhat.set(gap.what, gap);
  return [...byWhat.keys()].sort(byCodePoint).map((what) => byWhat.get(what)!);
}

// ---- tying a specifier to a file of the repository -------------------------

/**
 * The file a specifier names, or `undefined` where this stage cannot tie it to
 * one. Only a relative specifier (`./x`, `../x/y`) is resolved: a bare one
 * names a package outside the file tree, which is the resolver's business
 * (stage 4) and a gap of this scope until then. The candidates are tried in
 * one order and the first that exists wins, so the same tree always answers the
 * same file:
 *
 * 1. the path as written, when the tree holds a file there (`./x.ts`, `./x.go`);
 * 2. the path with each source extension in its place, which is how a
 *    TypeScript import of `./x.js` names the file `./x.ts` a reader edits;
 * 3. the path with each source extension appended, for the specifiers written
 *    without one (`./x` → `./x.ts`);
 * 4. the path as a folder with each extension's `index` file (`./x/index.ts`).
 */
export function resolveSpecifier(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base.startsWith('..') || base.startsWith('/')) return undefined;
  const candidates: string[] = [base];
  const extension = SOURCE_EXTENSIONS.find((candidate) => base.endsWith(candidate));
  if (extension !== undefined) {
    const stem = base.slice(0, base.length - extension.length);
    for (const candidate of SOURCE_EXTENSIONS) candidates.push(`${stem}${candidate}`);
  } else {
    for (const candidate of SOURCE_EXTENSIONS) candidates.push(`${base}${candidate}`);
  }
  for (const candidate of SOURCE_EXTENSIONS) candidates.push(`${base}/index${candidate}`);
  for (const candidate of candidates) {
    if (candidate !== base && !isSourcePath(candidate)) continue;
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/** Whether a path is written in a language this stage's grammars read. */
function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** One path read as a repository path, for a caller that holds a plain string (a unit's scope, say). */
export function asSourcePath(value: string): RepositoryPath {
  return repositoryPath(value);
}

/** The schema version each kind this stage produces is written at, as the registry declares it. */
export function syntaxProducedKinds(): readonly { kind: string; schemaVersion: number; scope: 'file' }[] {
  return (['comment', 'coverage', 'defines', 'entry-point', 'import', 'occurrence', 'symbol', 'test'] as const)
    .map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind].version, scope: 'file' as const }))
    .sort((left, right) => byCodePoint(left.kind, right.kind));
}
