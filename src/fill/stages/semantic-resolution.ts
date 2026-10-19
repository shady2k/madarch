/**
 * Stage 4 of the fill (decision 0026, "semantic resolution (SCIP/compiler where
 * available, syntactic fallback with its precision)"): the resolution stage
 * reads each source file of a pinned repository and writes what its names mean
 * — the symbol each mention of a name names, as an `occurrence`; the `call`,
 * `reference` and `inherits` edges those mentions fold into; and the file's
 * `coverage`, which names every reference the resolution could not tie to a
 * symbol with its own place, and the compiler index it did not have.
 *
 * **Units.** A unit is one source file, named `file:<repository>:<path>`, the
 * same file unit stage 3 plans: the incrementality is per file, and a commit
 * that moves one file's bytes moves that file's unit.
 *
 * **The plan reads what the previous runs published.** Before it names a unit,
 * the plan makes three tracked reads per repository — the inventory's published
 * tree (`publishedTreeRead`, the file facts with the blobs their bytes stood
 * under), the `import` edges stage 3 published (`publishedImportsRead`) and the
 * gaps of stage 3's coverage (`publishedGapsRead`, a specifier it could not tie
 * to a file among them).
 * The graph therefore answers which files moved at the pinned commit and which
 * files' resolution read the symbols of a file that moved. So a run plans:
 *
 * - a source file whose blob moved at the pinned commit, or that is new;
 * - a source file that imports a file whose blob moved or that the commit no
 *   longer holds — a resolver's answer for a name it takes from another file
 *   stands on that file's symbols, so those are the files whose resolution read
 *   them, and a target that vanished takes its symbols with it;
 * - a source file with a specifier stage 3 could not tie to a file, where that
 *   specifier names a file of the pinned tree now: a file that appears under a
 *   specifier an unchanged file already wrote is a symbol the file's resolution
 *   reads now and did not read before;
 * - a source file whose published `import` edge names a file its specifier no
 *   longer names, because a file appeared beside the old target (`./x.js` written
 *   beside the `x.ts` it resolved to) and the specifier answers the new one;
 * - a published source path the commit no longer holds, which publishes nothing
 *   and so retracts what an earlier run wrote for a file that was deleted or
 *   renamed away.
 *
 * The two rules about a specifier whose meaning moved are answered against this
 * stage's own last reading (`publishedReadsRead`): a target this stage already
 * read is one its edges already name — whatever stage 3's older gap or import
 * edge still says — so they plan a file once and not on every later run of an
 * unchanged commit. A graph that answers either read with nothing makes them a
 * no-op rather than a re-planning loop.
 *
 * **What one unit reads.** The file's own bytes come from the pinned snapshot
 * (`SnapshotSource`, stage 0) and never from a working tree. The symbols it
 * resolves against come from the graph, through tracked reads: the file's own
 * symbols, and the symbols of every file the file's imports name
 * (`publishedSymbolsRead`). Those reads are the unit's recorded dependencies,
 * so a file whose symbols change makes the units that read them stale — the
 * same relation the plan computes a run ahead.
 *
 * **The compiler's index is optional.** The unit asks the wiring for what a
 * compiler's index resolved for this file (`compilerIndexRead`, an optional
 * capability: `consumes.optional`); where it answers, each mention it names is
 * written at precision `compiler`, and where it does not, the mention is
 * resolved from what the file binds, at precision `syntactic`, and the file's
 * coverage names the index it did not have. No indexer is installed by this
 * change: the syntactic fallback is the one this madarch runs, and the read is
 * the seam a SCIP indexer would answer.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { FACT_ID_PATTERN, FACT_KINDS, isRepositoryPath, repositoryPath, type SymbolKind } from '../facts.js';
import type { SnapshotReader, SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { checkFactDraft, evidenceAt } from './draft.js';
import { publishedTreeRead, publishedTreeRows, rolesFor } from './inventory.js';
import { extractFileResolution, unreadFileResolution, type ExtractedFileResolution } from './resolution-extract.js';
import { resolutionFacts, type ResolutionFactSet, type ResolutionSymbolRow } from './resolution-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { fileFactIdOf, resolveSpecifier } from './syntax-facts.js';

/** The stage's id, as it is registered and as its units are named. */
export const SEMANTIC_RESOLUTION_STAGE_ID = 'semantic-resolution';

/** What a walk past the machine's stack answers: the one `RangeError` a unit reads as its file's gap. */
const STACK_OVERFLOW = /call stack|stack overflow/iu;

/** The stage's own version, bumped when what it writes or plans changes. */
export const SEMANTIC_RESOLUTION_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
export const SEMANTIC_RESOLUTION_STAGE_KINDS: readonly string[] = ['call', 'coverage', 'inherits', 'occurrence', 'reference'];

/** The read the plan makes: the `import` edges the graph holds for one repository. */
export const PUBLISHED_IMPORTS_READ = 'stage-4-published-imports';

/** The read one unit makes: the `symbol` facts the graph holds for one file. */
export const PUBLISHED_SYMBOLS_READ = 'stage-3-published-symbols';

/** The optional read: what a compiler's index resolved for one file, by the place of each mention. */
export const COMPILER_INDEX_READ = 'stage-4-compiler-index';

/** The read the plan makes: what stage 3 could not tie to a node, by the file it stood in. */
export const PUBLISHED_GAPS_READ = 'stage-3-coverage-gaps';

/** The read the plan makes: what this stage's own last run read for one file. */
export const PUBLISHED_READS_READ = 'stage-4-published-reads';

/**
 * The read the plan makes: the `import` edges stage 3 published for one
 * repository, which tell which files' resolution read another file's symbols.
 * The text is a JSON document, so a wiring reads it as data and not as prose.
 */
export function publishedImportsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_IMPORTS_READ, repository });
}

/**
 * The read the plan makes: what stage 3 published as a gap for one repository —
 * a specifier it could not tie to a file among them. A file's resolution can
 * move without the file's own bytes moving: a specifier that named nothing when
 * stage 3 read the file names a file once one appears, and that file is one this
 * stage's resolution reads.
 */
export function publishedGapsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_GAPS_READ, repository });
}

/**
 * The read the plan makes: the files this stage's own last resolution read for
 * one repository, from its own `coverage` facts. It is what keeps the two rules
 * about a specifier whose meaning moved from firing again on every later run of
 * an unchanged commit: a target this stage already read is a target its edges
 * already name, whatever stage 3's older gap or import edge still says.
 */
export function publishedReadsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_READS_READ, repository });
}

/** The read one unit makes: the symbols the graph holds for one file of one repository. */
export function publishedSymbolsRead(repository: string, path: string): string {
  return JSON.stringify({ read: PUBLISHED_SYMBOLS_READ, repository, path });
}

/**
 * The read one unit makes for the optional compiler index: what the compiler
 * resolved for one file. A wiring with a SCIP index answers rows of the symbol
 * each mention names; a wiring without one answers nothing, which is what every
 * run of this madarch does today.
 */
export function compilerIndexRead(repository: string, path: string): string {
  return JSON.stringify({ read: COMPILER_INDEX_READ, repository, path });
}

/** One row of the plan's read: an `import` edge between two files of the repository, by fact id. */
export interface PublishedImportRow {
  readonly kind: 'import';
  readonly from: string;
  readonly to: string;
  /** The specifier the importer wrote (`./order.js`), which tells whether it names the same file at the pinned commit. */
  readonly specifier: string;
}

/** One row of the plan's own read: what this stage's last run read for one file, the file itself among them. */
export interface PublishedReadRow {
  readonly kind: 'coverage';
  /** The file the coverage is about. */
  readonly file: string;
  /** The files that resolution read, in code point order, each once. */
  readonly read: readonly string[];
}

/** One row of the plan's gap read: one thing stage 3 could not tie to a node, in the file it stood in. */
export interface PublishedGapRow {
  readonly kind: 'coverage';
  /** The file the gap stands in. */
  readonly file: string;
  /** What could not be read: a specifier, a path, or a question the reader could not answer. */
  readonly what: string;
}

/** The keys a row of the plan's read holds, and no others. */
const IMPORT_ROW_FIELDS: readonly string[] = ['from', 'kind', 'specifier', 'to'];

/** The keys a gap row holds, and no others. */
const GAP_ROW_FIELDS: readonly string[] = ['file', 'kind', 'what'];

/** The keys a read row holds, and no others. */
const READ_ROW_FIELDS: readonly string[] = ['file', 'kind', 'read'];

/** The keys a symbol row holds, and no others. */
const SYMBOL_ROW_FIELDS: readonly string[] = ['endColumn', 'endLine', 'file', 'id', 'kind', 'qualifiedName', 'startColumn', 'startLine', 'symbolKind'];

/** The keys an index row holds, and no others. */
const INDEX_ROW_FIELDS: readonly string[] = ['column', 'line', 'symbol'];

/** The symbol kinds a symbol row may name, as the schema declares them. */
const SYMBOL_KINDS: readonly string[] = ['class', 'constant', 'constructor', 'enum', 'enum-member', 'event', 'field', 'function', 'interface', 'macro', 'method', 'module', 'namespace', 'object', 'operator', 'other', 'package', 'parameter', 'property', 'struct', 'trait', 'type', 'type-alias', 'type-parameter', 'variable'];

/**
 * The stage, built over the source that holds the run's pins. `plan` reads the
 * published tree and the published imports; each unit reads one file's bytes
 * and the symbols of the files it imports, and writes that file's resolution.
 */
export function createSemanticResolutionStage(sources: SnapshotSource): FillStage {
  return {
    id: SEMANTIC_RESOLUTION_STAGE_ID,
    version: SEMANTIC_RESOLUTION_STAGE_VERSION,
    // The file facts stage 1 published are what the plan compares blobs
    // against; stage 3's `import` edges draw the plan's second rule and its
    // `symbol` facts are what every name is resolved against. A graph without
    // them is a resolution with nothing to resolve, which the registry reports
    // as starvation rather than a stage that writes edges to nodes nobody
    // published. The compiler index is optional: read when a wiring has one,
    // absent in every run of this madarch today.
    consumes: {
      required: [
        { capability: 'file', scope: 'repository', freshness: 'current' },
        { capability: 'import', scope: 'repository', freshness: 'current' },
        { capability: 'symbol', scope: 'file', freshness: 'current' },
      ],
      optional: [{ capability: 'scip-index', scope: 'repository', freshness: 'current' }],
    },
    // A unit's publication replaces only that unit's facts (0027), and every
    // edge this stage writes has its `from` end a symbol of the unit's own
    // file: the ownership scope is the file, like stage 3's.
    produces: [
      { kind: 'call', schemaVersion: FACT_KINDS['call'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'inherits', schemaVersion: FACT_KINDS['inherits'].version, scope: 'file' },
      { kind: 'occurrence', schemaVersion: FACT_KINDS['occurrence'].version, scope: 'file' },
      { kind: 'reference', schemaVersion: FACT_KINDS['reference'].version, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planResolution(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeResolutionUnit(sources, unit, context),
    validate: (draft: StageDraftSet) => checkFactDraft(SEMANTIC_RESOLUTION_STAGE_ID, SEMANTIC_RESOLUTION_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run of the resolution fills: a unit per source file whose blob
 * moved at the pinned commit (or that is new), a unit per source file whose
 * resolution read the symbols of a file that moved, and a retraction for a
 * published source path the commit no longer holds. The plan is in code point
 * order of the unit ids, so two runs of one commit plan the same units in the
 * same order.
 */
async function planResolution(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const published = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead).files;
    const importsRead = publishedImportsRead(pin.id);
    const imports = publishedImportRows(await graph.query(importsRead), pin.id, importsRead);
    const gapsRead = publishedGapsRead(pin.id);
    const gaps = publishedGapRows(await graph.query(gapsRead), pin.id, gapsRead);
    const readsRead = publishedReadsRead(pin.id);
    const reads = publishedReadRows(await graph.query(readsRead), pin.id, readsRead);
    // What this stage's own last run read for each file: a target it already read
    // is one its edges already name, so a specifier whose meaning moved plans
    // that file once and not on every run after it.
    const readOf = new Map<string, ReadonlySet<string>>(reads.map((row) => [row.file, new Set(row.read)]));
    const mine = reader.files().filter((entry) => isSourcePath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    const held = new Set<string>(reader.files().map((entry) => String(entry.path)));
    // A file whose blob did not move is already resolved, so this run plans no
    // unit for it; the blob is what tells one reading of a file from the next.
    // A source path the commit no longer holds moved too: its importers read the
    // symbols it held, and they are re-resolved below like any other importer.
    const moved = new Set<string>();
    for (const entry of mine) {
      if (published.get(entry.path) !== entry.id) moved.add(entry.path);
    }
    for (const path of published.keys()) {
      if (!present.has(path) && isSourcePath(path)) moved.add(path);
    }
    // The path of each file id the graph answers for this repository, so an
    // import edge is read back as the two files it joins. A published path is
    // what the tree read holds, and a file fact's id is the digest of its
    // repository and its path (stage 3, `fileFactIdOf`).
    const pathById = new Map<string, string>();
    for (const path of published.keys()) pathById.set(fileFactIdOf(pin.id, path), path);
    const again = new Set<string>(moved);
    for (const edge of imports) {
      const target = pathById.get(edge.to);
      const importer = pathById.get(edge.from);
      // An edge whose file the tree no longer holds plans nothing: the file it
      // names is gone, and stage 3's own plan retracts its facts.
      if (target === undefined || importer === undefined) continue;
      if (!present.has(importer)) continue;
      if (moved.has(target)) {
        again.add(importer);
        continue;
      }
      // The specifier names another file of the pinned tree now: a file that
      // appears beside the one an import resolved to (`./x.js` written beside
      // the `x.ts` it named) moves the import's own resolution without moving
      // any file the earlier run read.
      const now = resolveSpecifier(importer, edge.specifier, held);
      if (now !== undefined && now !== target && readOf.get(importer)?.has(now) !== true) again.add(importer);
    }
    // A specifier stage 3 could not tie to a file names one now: a file appeared
    // under it, so the file that wrote it reads symbols it did not read before.
    for (const gap of gaps) {
      if (!present.has(gap.file)) continue;
      const now = resolveSpecifier(gap.file, gap.what, held);
      if (now === undefined || readOf.get(gap.file)?.has(now) === true) continue;
      again.add(gap.file);
    }
    for (const path of again) {
      if (!present.has(path) || !isSourcePath(path)) continue;
      units.push({ id: fileUnitId(pin.id, path), scope: `${pin.id}:${path}` });
    }
    for (const path of published.keys()) {
      // A published source path the commit no longer holds: the unit publishes
      // nothing, and the publication retracts what an earlier run wrote there.
      if (present.has(path) || !isSourcePath(path)) continue;
      units.push({ id: fileUnitId(pin.id, path), scope: `${pin.id}:${path}` });
    }
  }
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** Whether a path is a file this stage resolves: the inventory's own rule, the role the path names. */
function isSourcePath(path: string): boolean {
  return rolesFor(path).includes('source');
}

// ---- one unit ------------------------------------------------------------

/**
 * One unit: the source file the unit names, read at the pinned commit, resolved
 * against the symbols the graph holds. A path the commit no longer holds
 * publishes nothing, so an earlier run's facts for a deleted or renamed file are
 * retracted by the publication itself; a file whose bytes are no source text
 * here (a symbolic link, a submodule) is published as a coverage gap, since a
 * file this stage did not read must say so.
 */
async function executeResolutionUnit(sources: SnapshotSource, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const reader = await sources.open(planned.repository);
  refuseWhenCancelled(unit, context);
  const entry = reader.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${reader.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  if (entry.form !== 'blob') {
    writeDraft(context, reader, planned.path, await factsOf(context, reader, planned.path, unreadFileResolution(planned.path, 'unsupported')));
    const what = entry.form === 'link' ? 'a symbolic link, whose bytes are the path it points at' : 'a submodule, whose tree stands in the repository it names';
    context.progress(`${planned.path} is ${what}: the file is published as a coverage gap and not resolved`, 1);
    return { outcome: 'draft' };
  }
  const bytes = await reader.read(planned.path);
  refuseWhenCancelled(unit, context);
  let findings: ExtractedFileResolution;
  try {
    findings = await extractFileResolution(planned.path, bytes);
  } catch (error) {
    // The walk is recursive, so a file nested past the call stack's depth is
    // read as far as the machine allows and named as unread: one such file is a
    // coverage gap of its unit, never a unit that raises and loses the file.
    // Every other error still travels — a defect is not a silence.
    if (!(error instanceof RangeError) || !STACK_OVERFLOW.test(error.message)) throw error;
    findings = unreadFileResolution(planned.path, 'error');
    context.progress(`${planned.path} of ${planned.repository} is nested past what this reader can walk: the file is published as a coverage gap and not resolved`, 1);
  }
  refuseWhenCancelled(unit, context);
  const set = await factsOf(context, reader, planned.path, findings);
  writeDraft(context, reader, planned.path, set);
  if (!findings.parsed) {
    context.progress(`${planned.path} of ${planned.repository} was not read: the file is published as a coverage gap and not resolved`, 1);
    return { outcome: 'draft' };
  }
  const calls = set.facts.filter((fact) => fact.kind === 'call').length;
  const references = set.facts.filter((fact) => fact.kind === 'reference').length;
  const inherits = set.facts.filter((fact) => fact.kind === 'inherits').length;
  context.progress(
    `resolved ${planned.path} of ${planned.repository} at ${reader.commit}: ${set.resolvedMentions} ${set.resolvedMentions === 1 ? 'mention' : 'mentions'} tied to a symbol (${calls} ${calls === 1 ? 'call' : 'calls'}, ${references} ${references === 1 ? 'reference' : 'references'}, ${inherits} inherited), ${set.unresolvedMentions} unresolved, ${set.coverage.read.length - 1} other ${set.coverage.read.length - 1 === 1 ? 'file' : 'files'} read for their symbols`,
    1,
  );
  return { outcome: 'draft' };
}

/**
 * One file's resolution: the symbols of the file itself and of every file its
 * imports name, each through a tracked read, and what a compiler's index
 * answered for the file. The reads are the unit's dependencies, so a later run
 * that moves one of those files' symbols makes this unit stale.
 */
async function factsOf(context: StageContext, reader: SnapshotReader, path: string, findings: ExtractedFileResolution): Promise<ResolutionFactSet> {
  const repository = reader.repository;
  const ownRead = publishedSymbolsRead(repository, path);
  const fileSymbols = symbolRows(await context.graph.query(ownRead), repository, path, ownRead);
  const known = new Set<string>(reader.files().map((entry) => String(entry.path)));
  const readSymbols = new Map<string, readonly ResolutionSymbolRow[]>();
  const seen = new Set<string>();
  for (const entry of findings.imports) {
    const target = resolveSpecifier(path, entry.specifier, known);
    if (target === undefined || seen.has(target)) continue;
    seen.add(target);
    const read = publishedSymbolsRead(repository, target);
    readSymbols.set(target, symbolRows(await context.graph.query(read), repository, target, read));
  }
  const indexRead = compilerIndexRead(repository, path);
  const index = indexRows(await context.graph.query(indexRead), repository, path, indexRead);
  return resolutionFacts({
    repository,
    commit: reader.commit,
    path: repositoryPath(path),
    findings,
    files: [...known],
    fileSymbols,
    readSymbols,
    index,
    indexAnswered: index.size > 0,
  });
}

/** Writes each of one file's facts into the unit's draft, citing the repository, the commit and the path they were read from. */
function writeDraft(context: StageContext, reader: SnapshotReader, path: string, set: ResolutionFactSet): void {
  const evidence = evidenceAt(reader, path);
  for (const fact of set.facts) context.draft.write({ kind: 'fact', evidence, value: fact });
}

/**
 * A cancelled unit stops where it stands, and a unit that has read nothing is
 * no draft: the publication of an empty fact set retracts what the unit wrote
 * before, which a cancellation must never do in silence.
 */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it resolved the pinned file: a cancelled unit publishes nothing`);
  }
}

// ---- reading a read's rows ------------------------------------------------

/**
 * The plan's read, read: each row is an `import` edge of this repository, an
 * object naming the kind and the two file facts it joins. A row that names
 * another kind, an id that is no fact id of a `file`, or a key this read does
 * not define is refused, naming the read, the row and the field — a row read
 * past would plan a wrong unit in silence, and a row dropped would leave a
 * stale resolution behind.
 */
export function publishedImportRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedImportRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'an import edge of the repository');
    unknownKeys(held, IMPORT_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'import') throw refuse(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "import" edges`);
    const specifier = held['specifier'];
    if (typeof specifier !== 'string' || specifier.trim() === '') {
      throw refuse(read, index, repository, `its specifier ${JSON.stringify(specifier)} is no specifier: an import edge names the text the importing file wrote`);
    }
    return {
      kind: 'import',
      from: fileIdIn(held['from'], read, index, repository, 'from'),
      to: fileIdIn(held['to'], read, index, repository, 'to'),
      specifier,
    };
  });
}

/**
 * The plan's gap read, read: each row is one gap of stage 3's coverage of a file
 * — a specifier it could not tie to a file, a language it could not read, a
 * question it could not answer. A row naming another kind, a file that is no
 * repository path, or a key this read does not define is refused, naming the
 * read, the row and the field: a row read past would leave a file's resolution
 * stale in silence.
 */
export function publishedGapRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedGapRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'a gap of a file\'s coverage');
    unknownKeys(held, GAP_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuse(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" gaps`);
    const file = held['file'];
    if (typeof file !== 'string' || !isRepositoryPath(file)) {
      throw refuse(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a gap stands in a file of the repository`);
    }
    const what = held['what'];
    if (typeof what !== 'string' || what.trim() === '') {
      throw refuse(read, index, repository, `its what ${JSON.stringify(what)} is no gap: a gap names what the reader could not read`);
    }
    return { kind: 'coverage', file, what };
  });
}

/**
 * The plan's own read, read: each row is one file's coverage as this stage
 * published it, with the files that resolution read. A row naming another kind,
 * a file that is no repository path, a list of paths that is not one, or a key
 * this read does not define is refused, naming the read, the row and the field.
 */
export function publishedReadRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedReadRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'what a file\'s resolution read');
    unknownKeys(held, READ_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuse(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || !isRepositoryPath(file)) {
      throw refuse(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a coverage stands for a file of the repository`);
    }
    const readFiles = held['read'];
    if (!Array.isArray(readFiles)) {
      throw refuse(read, index, repository, `its read ${JSON.stringify(readFiles)} is no list of paths: a coverage names the files its resolution read`);
    }
    const paths = readFiles.map((entry, at) => {
      if (typeof entry !== 'string' || !isRepositoryPath(entry)) {
        throw refuse(read, index, repository, `its read[${at}] ${JSON.stringify(entry)} is no repository path`);
      }
      return entry;
    });
    return { kind: 'coverage', file, read: paths };
  });
}

/**
 * One unit's read of a file's symbols, read: each row names the symbol fact,
 * the file it is declared in, its qualified name and kind, and the range its
 * declaration stands at. That range is what tells whether a mention stands
 * inside the declaration and which declaration is nearest; a row whose range is
 * no range, whose file is another file, or whose id is no fact id is refused,
 * naming the read, the row and the field.
 */
export function symbolRows(rows: readonly unknown[], repository: string, path: string, read: string): readonly ResolutionSymbolRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, `the symbols of ${JSON.stringify(path)}`);
    unknownKeys(held, SYMBOL_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'symbol') throw refuse(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "symbol" facts`);
    const file = held['file'];
    if (file !== path) {
      throw refuse(read, index, repository, `it is declared in ${JSON.stringify(file)}, and the read was for ${JSON.stringify(path)}: one read is one file's symbols`);
    }
    const id = held['id'];
    if (typeof id !== 'string' || !FACT_ID_PATTERN.test(id) || !id.startsWith('symbol:')) {
      throw refuse(read, index, repository, `its id ${JSON.stringify(id)} is no symbol fact id: a symbol fact's id is "symbol:" and the digest of what the symbol is`);
    }
    const qualifiedName = held['qualifiedName'];
    if (typeof qualifiedName !== 'string' || qualifiedName.trim() === '') {
      throw refuse(read, index, repository, `its qualified name ${JSON.stringify(qualifiedName)} is no name`);
    }
    const symbolKind = held['symbolKind'];
    if (typeof symbolKind !== 'string' || !SYMBOL_KINDS.includes(symbolKind)) {
      throw refuse(read, index, repository, `its symbol kind ${JSON.stringify(symbolKind)} is no kind of symbol the schema names: ${SYMBOL_KINDS.join(', ')}`);
    }
    return { id, file: repositoryPath(file), qualifiedName, symbolKind: symbolKind as SymbolKind, range: rangeIn(held, read, index, repository) };
  });
}

/**
 * One unit's optional read of a compiler's index, read: each row names the
 * place of a mention and the symbol fact the name at that place names. An
 * answer with no row means this run has no index for the file, which the
 * coverage names; a row whose place is no line and column, whose symbol is no
 * fact id, or whose place stands twice is refused.
 */
export function indexRows(rows: readonly unknown[], repository: string, path: string, read: string): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  rows.forEach((row, at) => {
    const held = rowRecord(row, read, at, repository, `what a compiler's index resolved in ${JSON.stringify(path)}`);
    unknownKeys(held, INDEX_ROW_FIELDS, read, at, repository);
    const line = held['line'];
    const column = held['column'];
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      throw refuse(read, at, repository, `its line ${JSON.stringify(line)} is no line: a mention's line is a whole number from 1`);
    }
    if (typeof column !== 'number' || !Number.isInteger(column) || column < 0) {
      throw refuse(read, at, repository, `its column ${JSON.stringify(column)} is no column: a mention's column is a whole number from 0`);
    }
    const symbol = held['symbol'];
    if (typeof symbol !== 'string' || !FACT_ID_PATTERN.test(symbol) || !symbol.startsWith('symbol:')) {
      throw refuse(read, at, repository, `its symbol ${JSON.stringify(symbol)} is no symbol fact id: the index names the symbol fact the place resolves to`);
    }
    const key = `${line}:${column}`;
    const first = index.get(key);
    if (first !== undefined) {
      throw refuse(read, at, repository, `its place ${key} stands in an earlier row of this answer, as ${JSON.stringify(first)}: one index answers one symbol per place`);
    }
    index.set(key, symbol);
  });
  return index;
}

/** One row of a read, as an object; a row that is no object is refused, naming the read and the row. */
function rowRecord(row: unknown, read: string, index: number, repository: string, what: string): Record<string, unknown> {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw refuse(read, index, repository, `${JSON.stringify(row)} is no row: this read answers ${what}, each an object naming its fields`);
  }
  return row as Record<string, unknown>;
}

/** A row's keys, none of them a key this read does not define. */
function unknownKeys(held: Record<string, unknown>, fields: readonly string[], read: string, index: number, repository: string): void {
  const unknown = Object.keys(held).filter((key) => !fields.includes(key)).sort(byCodePoint);
  if (unknown.length > 0) {
    throw refuse(read, index, repository, `it holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a row holds ${fields.join(', ')}: a run, a unit, an attempt or a session is none of them`);
  }
}

/** A file fact id a row names, refused where it is no id of a `file` fact. */
function fileIdIn(value: unknown, read: string, index: number, repository: string, field: string): string {
  if (typeof value !== 'string' || !FACT_ID_PATTERN.test(value) || !value.startsWith('file:')) {
    throw refuse(read, index, repository, `its ${field} ${JSON.stringify(value)} is no file fact id: an import edges two file facts of this repository`);
  }
  return value;
}

/** The declaration range a symbol row carries, refused where it is no range. */
function rangeIn(held: Record<string, unknown>, read: string, index: number, repository: string): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
  const range = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    const value = held[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw refuse(read, index, repository, `its ${field} ${JSON.stringify(value)} is no line or column: a declaration's range is whole numbers from 0`);
    }
    range[field] = value;
  }
  if (range.endLine < range.startLine) {
    throw refuse(read, index, repository, `its range ends on line ${range.endLine} and starts on line ${range.startLine}: a range's end is never before its start`);
  }
  return range;
}

/** What one refusal says: the read, the row it answered, and what was wrong with it. */
function refuse(read: string, index: number, repository: string, detail: string): Error {
  return new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
}
