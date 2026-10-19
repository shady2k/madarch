/**
 * Stage 5 of the fill (decision 0026, "modules by recursive clustering of the
 * dependency graph (packages and build targets as seeds, a size threshold) and
 * importance by PageRank"; stage 5 of the eight): the modules stage reads what
 * the stages before it published for one repository and writes the repository
 * as a tree of `module` facts, the `contains` edges that hold it together, and
 * the importance of every file, symbol and module of that tree.
 *
 * **Units.** One unit is one repository, named `modules:<repository>`, its scope
 * `<repository>`. Clustering is not per file: a cluster's boundary depends on
 * every other cluster of the repository, and a rank depends on the whole
 * graph's edges, so the smallest unit that computes the same answer twice is
 * the repository (0026's own hierarchy: product → repository → package → cluster
 * → sub-cluster, split until a unit's estimate fits). The run's wiring hashes
 * what the unit read (madarch-tzte.21.8), so a commit that moves no fact this
 * stage reads replans no unit; a commit that moves one re-clusters the
 * repository it stands in, and no other.
 *
 * **What one unit reads.** Four tracked reads of the pinned graph, each the
 * unit's own dependency, so a publication that changes one of them makes this
 * unit stale (0027):
 *
 * - the `package` facts stage 2 published (`publishedPackagesRead`), which are
 *   the clustering's seeds — a package or a build target, never a workspace,
 *   whose manifest names the folder it stands for;
 * - the `file` facts stage 1 published, each with the value it holds and the
 *   place it stands at (`publishedFilesRead`), which is what a module holds and
 *   what a rank is written onto;
 * - the `symbol` facts stages 3 and 4 published (`publishedSymbolsRead`), for
 *   the same reason: the symbols of a file are that file's symbols in the
 *   cluster, and each is ranked;
 * - the resolved edges the graph holds — `import` (stage 3) and `call`,
 *   `reference` and `inherits` (stage 4), with the site count stage 4 folded
 *   into an edge (`resolvedEdgesRead`) — which are what PageRank walks.
 *
 * **Recursive clustering.** A file belongs to the seed whose manifest's folder
 * is the longest prefix of its path (two seeds claiming one folder are told
 * apart by their manifest's path in code point order), and a repository with no
 * seed at all is one cluster named after the repository. A cluster that holds
 * more files than the size threshold is split by the folder each of its files
 * stands in, at every level, and each of those clusters is split again by the
 * same rule until it fits — which is what makes a module's name its name
 * *inside its parent* (0026's "product → repository → package → cluster →
 * sub-cluster, split until a unit's estimate fits"). Files standing directly in
 * a cluster's own folder stay in it; a cluster that is still over the threshold
 * once no deeper folder is left is named in the unit's coverage, never dropped.
 *
 * **Fan-in is bounded.** A cluster with more than the fan-in bound of children
 * groups them, in code point order, into intermediate modules named `part-1`,
 * `part-2` and so on among their parent's children, and groups the groups again
 * while the bound is still exceeded: 0026 bounds fan-in at about fifty children
 * "else an intermediate grouping level", so no module's children are ever more
 * than the bound.
 *
 * **Importance.** One PageRank walks the repository's own graph: every file and
 * every symbol is a node, an `import` edge joins two files, the `call`,
 * `reference` and `inherits` edges join two symbols with the site count stage 4
 * folded into them as the edge's weight, and the file that declares a symbol
 * points at it, so a file's rank reaches the symbols it holds. Damping is 0.85
 * and a node with no outgoing edge spreads its rank uniformly, as PageRank
 * defines; the walk stops when no node moved by more than 1e-12 or after 100
 * turns, so a graph answers the same vector in every run and on every machine.
 * A file's and a symbol's importance is its own share of that vector, written with
 * twelve decimals; a module's is the share its members hold — the sum of their
 * ranks over the sum of every node's, which is what makes the modules of one
 * repository sum to one and every rank a number in [0, 1]. The same graph answers
 * the same number: the walk is deterministic, and its last digits are the
 * residual it stopped at, which is the same residual in every run.
 *
 * **A rank is written onto the fact it ranks.** The file and symbol facts this
 * stage publishes are the facts stages 1, 3 and 4 published — one id, one node —
 * with `importance` added, and its `contains` edges name exactly those nodes.
 * The declaration below says why that kind is not named in `produces`.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import {
  FACT_ID_PATTERN, FACT_KINDS, factId, isRepositoryPath, makeEdgeFact, makeNodeFact, repositoryPath,
  type CoverageGap, type CoverageGapReason, type Fact, type FactProvenance, type FactRange, type FactSource, type FileValue,
  type ModuleSeed, type PackageForm, type SymbolKind, type SymbolValue,
} from '../facts.js';
import type { SnapshotReader, SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { checkFactDraft, evidenceAt, provenanceOf } from './draft.js';

/** The stage's id, as it is registered and as its units are named. */
export const MODULES_STAGE_ID = 'modules';

/** The stage's own version, bumped when what it reads, plans or writes changes. */
export const MODULES_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage writes, in code point order: the modules,
 * the containment that holds them, the coverage of what was read, and the
 * `file` and `symbol` facts whose `importance` this stage measures.
 *
 * `file` and `symbol` stand in this list and not in `produces` below: `produces`
 * declares which stage a consumer of a capability waits for, and a second
 * producer of `file` would draw an edge from this stage to every stage that
 * consumes `file` — the syntax stage among them — while this stage consumes the
 * syntax stage's `import` and `symbol`, which is a cycle in the derived stage
 * graph (decision 0027), refused by the registry. A rank is not a capability
 * another stage waits for: it is a field of a fact two stages already published,
 * and the only thing this stage says about it is its value.
 */
export const MODULES_STAGE_KINDS: readonly string[] = ['contains', 'coverage', 'file', 'module', 'symbol'];

/**
 * The reader this stage's own facts name: the fill's modules stage. It reads the
 * graph and no bytes, so its provenance is neither git's nor a compiler's — and
 * that is what keeps its `coverage` of a repository apart from stage 0's
 * coverage of the same repository, whose identity is the repository, the scope
 * and the reader (`coverage`'s own parts, `facts.ts`): two readers of one
 * repository are two coverages that add up, and a stage that named git's reader
 * would have its gaps overwritten by stage 0's row (the store keeps the first
 * publication of an id). The version moves with the stage's own.
 */
const MODULES_SOURCE: FactSource = { system: 'madarch-fill', version: String(MODULES_STAGE_VERSION) };

/** The read the unit makes: the `package` facts stage 2 published for the repository. */
export const PUBLISHED_PACKAGES_READ = 'stage-5-published-packages';

/** The read the unit makes: the `file` facts stage 1 published, with the value and place each holds. */
export const PUBLISHED_FILES_READ = 'stage-5-published-files';

/** The read the unit makes: the `symbol` facts stages 3 and 4 published, with the value and place each holds. */
export const PUBLISHED_SYMBOLS_READ = 'stage-5-published-symbols';

/**
 * The read the unit makes: the resolved edges the graph holds for one repository,
 * by fact id — the `import` edges between files (the schema also lets an import
 * end at a module or a package, and this read asks for the file-to-file ones,
 * which are the nodes the rank walks) and the `call`, `reference` and `inherits`
 * edges between symbols, each with the sites stage 4 folded into it.
 */
export const RESOLVED_EDGES_READ = 'stage-5-resolved-edges';

/** The size threshold a product that configures nothing gets: 0026's unit fits about this many files. */
export const DEFAULT_SIZE_THRESHOLD = 50;

/** The fan-in bound a product that configures nothing gets: 0026 bounds a module's children at about fifty. */
export const DEFAULT_MAX_FAN_IN = 50;

/** The smallest fan-in bound that can group anything: a bound of one groups one child into one group, and never ends. */
export const MIN_MAX_FAN_IN = 2;

/** PageRank's damping factor, as 0026 and the field's practice fix it. */
const DAMPING = 0.85;

/** How little movement ends the walk: no node moved by more than this. */
const RANK_EPSILON = 1e-12;

/** The most turns the walk takes, so a pathological graph still answers. */
const RANK_MAX_TURNS = 100;

/** How many decimals a rank is written with: enough to order two nodes, few enough to be the same number in every run. */
const RANK_DECIMALS = 12;

/** The kinds of edge the rank walks, and the only ones this stage reads. */
const RESOLVED_EDGE_KINDS: readonly string[] = ['call', 'import', 'inherits', 'reference'];

/** The symbol kinds the schema names, so a symbol row's kind is one of them. */
const SYMBOL_KINDS: readonly string[] = ['class', 'constant', 'constructor', 'enum', 'enum-member', 'event', 'field', 'function', 'interface', 'macro', 'method', 'module', 'namespace', 'object', 'operator', 'other', 'package', 'parameter', 'property', 'struct', 'trait', 'type', 'type-alias', 'type-parameter', 'variable'];

/**
 * The read the unit makes: the `package` facts stage 2 published for one
 * repository. The text is a JSON document, so a wiring reads it as data and not
 * as prose: `{"read": "stage-5-published-packages", "repository": "<name>"}`.
 */
export function publishedPackagesRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_PACKAGES_READ, repository });
}

/** The read the unit makes: the `file` facts stage 1 published for one repository. */
export function publishedFilesRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_FILES_READ, repository });
}

/** The read the unit makes: the `symbol` facts stages 3 and 4 published for one repository. */
export function publishedSymbolsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_SYMBOLS_READ, repository });
}

/** The read the unit makes: the resolved edges the graph holds for one repository. */
export function resolvedEdgesRead(repository: string): string {
  return JSON.stringify({ read: RESOLVED_EDGES_READ, repository });
}

/** The unit id of one repository's clustering, and the scope it covers. */
export function modulesUnitId(repository: string): string {
  return `modules:${repository}`;
}

/** One row of the packages read: a seed stage 2 published. */
export interface PublishedPackageRow {
  readonly kind: 'package';
  readonly name: string;
  /** The package's form: a `workspace` holds packages and is no seed of a module. */
  readonly form: PackageForm;
  /** The manifest that declares it, whose folder is the one this package stands for. */
  readonly manifest?: string;
}

/** One row of the files read: a `file` fact and the place it stands at. */
export interface PublishedFileRow {
  readonly kind: 'file';
  readonly path: string;
  /** The id the file fact digests to: the node a `contains` edge names. */
  readonly id: string;
  /** The fact's own value, as the graph holds it. */
  readonly value: FileValue;
  /** The fact's own place: the file's whole extent at the commit. */
  readonly place: FactRange;
}

/** One row of the symbols read: a `symbol` fact, the file that declares it, and its place. */
export interface PublishedSymbolRow {
  readonly kind: 'symbol';
  readonly file: string;
  /** The id the symbol fact digests to: the node a `contains` edge names. */
  readonly id: string;
  /** The fact's own value, as the graph holds it. */
  readonly value: SymbolValue;
  /** The fact's own place: the declaration's range in its file. */
  readonly place: FactRange;
}

/** One row of the edges read: a resolved edge between two nodes of the repository, with the weight it carries. */
export interface ResolvedEdgeRow {
  readonly kind: 'call' | 'import' | 'inherits' | 'reference';
  readonly from: string;
  readonly to: string;
  /** How many sites the edge folded: stage 4's `count`, and one where the kind carries none. */
  readonly weight: number;
}

/** The stage's own configuration, as a unit runs with it. */
interface ModuleSettings {
  /** The most files one cluster holds before it is split by folder. */
  readonly sizeThreshold: number;
  /** The most child modules one module holds before they are grouped. */
  readonly maxFanIn: number;
}

/** The keys a package row holds, and no others. */
const PACKAGE_ROW_FIELDS: readonly string[] = ['form', 'kind', 'manifest', 'name'];

/** The keys a file row holds, and no others. */
const FILE_ROW_FIELDS: readonly string[] = ['id', 'kind', 'path', 'place', 'value'];

/** The keys a symbol row holds, and no others. */
const SYMBOL_ROW_FIELDS: readonly string[] = ['file', 'id', 'kind', 'place', 'value'];

/** The keys an edge row holds, and no others. */
const EDGE_ROW_FIELDS: readonly string[] = ['count', 'from', 'kind', 'to'];

/** The keys a place holds, and no others. */
const PLACE_FIELDS: readonly string[] = ['endColumn', 'endLine', 'startColumn', 'startLine'];

/**
 * The stage, built over the source that holds the run's pins: `plan` names one
 * unit per pinned repository that holds a file, and each unit reads that
 * repository's published graph and writes its modules, ranks and coverage.
 */
export function createModulesStage(sources: SnapshotSource): FillStage {
  return {
    id: MODULES_STAGE_ID,
    version: MODULES_STAGE_VERSION,
    // What the clustering is made of is required: the repository's files and the
    // symbols they declare. What the ranking walks beside them is optional — a
    // run with no resolution stage ranks over the imports alone, and one with no
    // build stage clusters the repository as a single root — because a missing
    // producer of those is a smaller graph, never a wrong one, and the coverage
    // of every unit says what it read.
    consumes: {
      required: [
        { capability: 'file', scope: 'repository', freshness: 'current' },
        { capability: 'symbol', scope: 'repository', freshness: 'current' },
      ],
      optional: [
        { capability: 'call', scope: 'repository', freshness: 'current' },
        { capability: 'import', scope: 'repository', freshness: 'current' },
        { capability: 'inherits', scope: 'repository', freshness: 'current' },
        { capability: 'package', scope: 'repository', freshness: 'current' },
        { capability: 'reference', scope: 'repository', freshness: 'current' },
      ],
    },
    // The kinds whose capability this stage is the producer of. A unit's
    // publication replaces only that unit's facts (0027), and the unit is one
    // repository, so the ownership scope of every kind here is the repository.
    produces: [
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'repository' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'repository' },
      { kind: 'module', schemaVersion: FACT_KINDS['module'].version, scope: 'repository' },
    ],
    // The threshold and the fan-in bound are the stage's own numbers, and a
    // product may set either: 0026 leaves both to the stage's defaults and a
    // product's configuration, and neither names anything a reader of the code
    // could read off the tree.
    configSchema: Type.Object({
      sizeThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
      maxFanIn: Type.Optional(Type.Integer({ minimum: MIN_MAX_FAN_IN })),
    }),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: { sizeThreshold: DEFAULT_SIZE_THRESHOLD, maxFanIn: DEFAULT_MAX_FAN_IN } },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planModules(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeModulesUnit(sources, unit, context),
    validate: (draft: StageDraftSet) => checkFactDraft(MODULES_STAGE_ID, MODULES_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run of the modules fills: one per pinned repository that holds
 * a file, in code point order of their ids. A repository that holds no file is
 * no cluster and no rank — a run that pinned nothing, or pinned a repository of
 * empty folders, has nothing for this stage to say, which `nothing-found` says
 * in the registry's own words (0027) rather than an empty plan that looks like
 * a graph somebody read.
 *
 * The plan makes no read of the graph, and it compares no blob: whether a
 * repository's clustering must run again is the run's own input digest
 * (madarch-tzte.21.8), the same seam stage 2's plan leaves its manifests to —
 * and here one unit covers the whole repository, so there is no second
 * granularity to plan instead.
 */
async function planModules(sources: SnapshotSource, _graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anyFile = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    if (reader.files().length === 0) continue;
    anyFile = true;
    units.push({ id: modulesUnitId(pin.id), scope: pin.id });
  }
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anyFile ? 'planned' : 'nothing-found' };
}

/** The repository a unit id names; an id this stage never plans is refused, naming the id and its shape. */
function plannedRepository(id: string): string {
  const kind = id.slice(0, Math.max(0, id.indexOf(':')));
  const repository = id.indexOf(':') < 0 ? '' : id.slice(id.indexOf(':') + 1);
  const refuse = (detail: string): Error => new Error(`the unit ${JSON.stringify(id)} is not one this stage plans, and ${detail}: a unit id is "modules:<repository>"`);
  if (kind !== 'modules') throw refuse(`its kind is ${JSON.stringify(kind)}`);
  if (!ID_PATTERN.test(repository)) throw refuse(`its repository ${JSON.stringify(repository)} is no repository name`);
  return repository;
}

// ---- one unit ------------------------------------------------------------

/**
 * One unit: the repository's published graph read through four tracked reads,
 * clustered into modules, ranked by PageRank, and written — the module facts,
 * the `contains` edges, the ranked file and symbol facts, and one coverage fact
 * saying what the unit read and what it could not read whole.
 */
async function executeModulesUnit(sources: SnapshotSource, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const repository = plannedRepository(unit.id);
  const settings = settingsOf(context.config.config);
  const reader = await sources.open(repository);
  refuseWhenCancelled(unit, context);
  const packagesRead = publishedPackagesRead(repository);
  const packages = packageRows(await context.graph.query(packagesRead), repository, packagesRead);
  const filesRead = publishedFilesRead(repository);
  const files = fileRows(await context.graph.query(filesRead), repository, filesRead);
  const symbolsRead = publishedSymbolsRead(repository);
  const symbols = symbolRows(await context.graph.query(symbolsRead), repository, symbolsRead);
  const edgesRead = resolvedEdgesRead(repository);
  const edges = edgeRows(await context.graph.query(edgesRead), repository, edgesRead);
  refuseWhenCancelled(unit, context);
  // The stage's own reader, not the bytes' (see `MODULES_SOURCE`): what it read is the graph.
  const provenance: FactProvenance = { ...provenanceOf(reader), source: MODULES_SOURCE };
  const clustered = clusterRepository({ repository, packages, files, settings });
  const ranks = rankNodes({ repository, files, symbols, edges });
  const written = writeClustering({ repository, reader, provenance, files, symbols, clustered, ranks });
  for (const fact of written.facts) context.draft.write({ kind: 'fact', evidence: evidenceAt(reader), value: fact });
  context.progress(
    `clustered ${repository} at ${reader.commit}: ${written.modules} ${written.modules === 1 ? 'module' : 'modules'} over ${files.length} ${files.length === 1 ? 'file' : 'files'} and ${symbols.length} ${symbols.length === 1 ? 'symbol' : 'symbols'}, ranked over ${edges.length} ${edges.length === 1 ? 'edge' : 'edges'}, ${written.gaps} ${written.gaps === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** A cancelled unit stops where it stands: the publication of an empty fact set retracts what an earlier run wrote, which a cancellation must never do in silence. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it clustered the pinned repository: a cancelled unit publishes nothing`);
  }
}

/**
 * The stage's own configuration, read field by field: the registry has judged
 * it against `configSchema` already, and a value that still does not read is
 * refused here by name rather than replaced by a default in silence.
 */
function settingsOf(config: unknown): ModuleSettings {
  const held: Record<string, unknown> = config !== null && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
  const read = (field: 'maxFanIn' | 'sizeThreshold', fallback: number): number => {
    const value = held[field];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`the modules stage's configuration holds ${JSON.stringify(value)} as its ${field}, and this stage reads a whole number of 1 or more: the value the registry judged is the value run with`);
    }
    return value;
  };
  const maxFanIn = read('maxFanIn', DEFAULT_MAX_FAN_IN);
  if (maxFanIn < MIN_MAX_FAN_IN) {
    throw new Error(`the modules stage's configuration holds ${JSON.stringify(maxFanIn)} as its maxFanIn, and a bound of one groups one child into one group and never ends: a module's fan-in bound is ${MIN_MAX_FAN_IN} or more`);
  }
  return { sizeThreshold: read('sizeThreshold', DEFAULT_SIZE_THRESHOLD), maxFanIn };
}

// ---- the reads, read ------------------------------------------------------

/** One row of a read, as an object; a row that is no object is refused, naming the read, the row and what it holds. */
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

/** What one refusal says: the read, the row it answered, and what was wrong with it. */
function refuse(read: string, index: number, repository: string, detail: string): Error {
  return new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
}

/**
 * The packages read, read: each row is a `package` fact of this repository — the
 * kind, the package's name, its form and the manifest that declares it. A row
 * naming another kind, a name that is none, a form the schema does not name, a
 * manifest that is no repository path, or a key this read does not define is
 * refused, naming the read, the row and the field: a seed read past would
 * cluster files under a package nobody declared.
 */
export function packageRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedPackageRow[] {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'the packages stage 2 published, one row each');
    unknownKeys(held, PACKAGE_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'package') throw refuse(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "package" facts`);
    const name = held['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw refuse(read, index, repository, `its name ${JSON.stringify(name)} is no package name: a package is named by its ecosystem's own name, never by nothing`);
    }
    const form = held['form'];
    if (typeof form !== 'string' || !['build-target', 'package', 'workspace'].includes(form)) {
      throw refuse(read, index, repository, `its form ${JSON.stringify(form)} is no form of package: the schema names build-target, package and workspace`);
    }
    const manifest = held['manifest'];
    if (manifest !== undefined && (typeof manifest !== 'string' || !isRepositoryPath(manifest))) {
      throw refuse(read, index, repository, `its manifest ${JSON.stringify(manifest)} is no repository path: a package names the manifest that declares it, from the repository's root`);
    }
    const key = `${form}\u0000${name.trim()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw refuse(read, index, repository, `it repeats row ${first + 1}: a package is one fact of its repository, its form and its name, and an answer holds it once`);
    }
    seen.set(key, index);
    return {
      kind: 'package',
      name: name.trim(),
      form: form as PackageForm,
      ...(typeof manifest === 'string' ? { manifest } : {}),
    };
  });
}

/**
 * The files read, read: each row is a `file` fact of this repository, with the
 * value it holds and the place it stands at. A row naming another kind, a path
 * that is no repository path, a value that names another file or another
 * repository, an id that is not the digest of the value, a place that is no
 * range, or a key this read does not define is refused, naming the read, the
 * row and the field — a file read past is a node the clustering would name and
 * the publication would not hold.
 */
export function fileRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedFileRow[] {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'the file facts stage 1 published, one row each');
    unknownKeys(held, FILE_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'file') throw refuse(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "file" facts`);
    const path = held['path'];
    if (typeof path !== 'string' || !isRepositoryPath(path)) {
      throw refuse(read, index, repository, `its path ${JSON.stringify(path)} is no repository path: a path from the repository's root, "/"-separated, with no "." or ".." leg`);
    }
    const value = held['value'];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw refuse(read, index, repository, `its value ${JSON.stringify(value)} is no file's value: a file fact holds the value the schema gives it`);
    }
    const fields = value as Record<string, unknown>;
    if (fields['repository'] !== repository) {
      throw refuse(read, index, repository, `its value names the repository ${JSON.stringify(fields['repository'])}, and the read was for ${JSON.stringify(repository)}: one fact is one repository`);
    }
    if (fields['path'] !== path) {
      throw refuse(read, index, repository, `its value names the path ${JSON.stringify(fields['path'])}, and the row names ${JSON.stringify(path)}: a file's row and its value are one file`);
    }
    const place = rangeIn(held['place'], read, index, repository);
    const placed = { ...fields, path: repositoryPath(path) } as unknown as FileValue;
    const id = factId({ kind: 'file', value: placed, provenance: anyProvenance });
    if (held['id'] !== id) {
      throw refuse(read, index, repository, `its id ${JSON.stringify(held['id'])} is not the digest of its value, which is ${JSON.stringify(id)}: an id is never written but computed from what the fact is`);
    }
    const first = seen.get(path);
    if (first !== undefined) {
      throw refuse(read, index, repository, `its path ${JSON.stringify(path)} stands in row ${first + 1}: one file is one fact, and an answer holds it once`);
    }
    seen.set(path, index);
    return { kind: 'file' as const, path, id, value: placed, place };
  });
}

/**
 * The symbols read, read: each row is a `symbol` fact of this repository, the
 * file that declares it, the value it holds and the place it stands at. A row
 * naming another kind, a file that is no repository path, a value that names
 * another file or another repository, a qualified name or a symbol kind the
 * schema does not name, an id that is not the digest of the value, a place that
 * is no range, or a key this read does not define is refused, naming the read,
 * the row and the field.
 */
export function symbolRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedSymbolRow[] {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'the symbol facts stages 3 and 4 published, one row each');
    unknownKeys(held, SYMBOL_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'symbol') throw refuse(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "symbol" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || !isRepositoryPath(file)) {
      throw refuse(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a symbol is declared in a file of the repository`);
    }
    const value = held['value'];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw refuse(read, index, repository, `its value ${JSON.stringify(value)} is no symbol's value: a symbol fact holds the value the schema gives it`);
    }
    const fields = value as Record<string, unknown>;
    if (fields['repository'] !== repository) {
      throw refuse(read, index, repository, `its value names the repository ${JSON.stringify(fields['repository'])}, and the read was for ${JSON.stringify(repository)}: one fact is one repository`);
    }
    if (fields['file'] !== file) {
      throw refuse(read, index, repository, `its value names the file ${JSON.stringify(fields['file'])}, and the row names ${JSON.stringify(file)}: a symbol's row and its value are one declaration`);
    }
    const qualifiedName = fields['qualifiedName'];
    if (typeof qualifiedName !== 'string' || qualifiedName.trim() === '') {
      throw refuse(read, index, repository, `its qualified name ${JSON.stringify(qualifiedName)} is no name`);
    }
    const symbolKind = fields['symbolKind'];
    if (typeof symbolKind !== 'string' || !SYMBOL_KINDS.includes(symbolKind)) {
      throw refuse(read, index, repository, `its symbol kind ${JSON.stringify(symbolKind)} is no kind of symbol the schema names: ${SYMBOL_KINDS.join(', ')}`);
    }
    const place = rangeIn(held['place'], read, index, repository);
    const placed = { ...fields, file: repositoryPath(file) } as unknown as SymbolValue;
    const id = factId({ kind: 'symbol', value: placed, provenance: anyProvenance });
    if (held['id'] !== id) {
      throw refuse(read, index, repository, `its id ${JSON.stringify(held['id'])} is not the digest of its value, which is ${JSON.stringify(id)}: an id is never written but computed from what the fact is`);
    }
    const first = seen.get(id);
    if (first !== undefined) {
      throw refuse(read, index, repository, `its id ${JSON.stringify(id)} stands in row ${first + 1}: one symbol is one fact, and an answer holds it once`);
    }
    seen.set(id, index);
    return { kind: 'symbol' as const, file, id, value: placed, place };
  });
}

/**
 * The edges read, read: each row is a resolved edge of this repository — an
 * `import` between two files, a `call`, a `reference` or an `inherits` between
 * two symbols — with the site count stage 4 folded into it. A row naming another
 * kind, an end that is no fact id of the kind the edge joins, a count on an edge
 * that carries none, a count that is no positive whole number, a pair of ends
 * this read answers twice, or a key this read does not define is refused, naming
 * the read, the row and the field: an edge read past would rank a node by a
 * relation nobody published.
 */
export function edgeRows(rows: readonly unknown[], repository: string, read: string): readonly ResolvedEdgeRow[] {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'the resolved edges the graph holds, one row each');
    unknownKeys(held, EDGE_ROW_FIELDS, read, index, repository);
    const kind = held['kind'];
    if (typeof kind !== 'string' || !RESOLVED_EDGE_KINDS.includes(kind)) {
      throw refuse(read, index, repository, `its kind is ${JSON.stringify(kind)}, and this read answers ${RESOLVED_EDGE_KINDS.join(', ')} edges`);
    }
    const ends = kind === 'import' ? 'file' : 'symbol';
    const from = endIn(held['from'], ends, read, index, repository, 'from', kind);
    const to = endIn(held['to'], ends, read, index, repository, 'to', kind);
    const key = `${kind}\u0000${from}\u0000${to}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw refuse(read, index, repository, `it repeats row ${first + 1}: one read answers one edge per pair of ends, and stage 4 folds a pair's sites into the edge's count`);
    }
    seen.set(key, index);
    const count = held['count'];
    let weight = 1;
    if (count !== undefined) {
      if (kind !== 'call' && kind !== 'reference') {
        throw refuse(read, index, repository, `it carries a count of ${JSON.stringify(count)}, and ${kind === 'import' ? 'an import' : 'an inheritance'} edge folds no sites: a count stands on a call or a reference`);
      }
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        throw refuse(read, index, repository, `its count ${JSON.stringify(count)} is no count of sites: stage 4 folds one or more sites into an edge`);
      }
      weight = count;
    }
    return { kind: kind as ResolvedEdgeRow['kind'], from, to, weight };
  });
}

/** A provenance with no place and no reader: the identity of a `file` or a `symbol` fact reads neither, and an id is what a read's row is held to. */
const anyProvenance: FactProvenance = { source: { system: '', version: '' }, repository: { id: '', commit: '' } };

/**
 * One end of an edge, refused where it is no fact id of a node the rank walks.
 * The schema lets an `import` name a file, a module or a package, and this read
 * asks for the imports between files: the walk is over files and symbols, and an
 * import of a package names no node of it, so a row naming one is refused here
 * rather than dropped from the rank.
 */
function endIn(value: unknown, ends: 'file' | 'symbol', read: string, index: number, repository: string, field: string, kind: string): string {
  if (typeof value !== 'string' || !FACT_ID_PATTERN.test(value) || !value.startsWith(`${ends}:`)) {
    throw refuse(read, index, repository, `its ${field} ${JSON.stringify(value)} is no ${ends} fact id: ${kind === 'import' ? 'this read asks for the imports between two files' : `a ${kind} edge joins two symbol facts`}`);
  }
  return value;
}

/** The place a read's row carries: four whole numbers and an ascending range, refused by name otherwise. */
function rangeIn(value: unknown, read: string, index: number, repository: string): FactRange {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw refuse(read, index, repository, `its place ${JSON.stringify(value)} is no place: a fact stands at a file and a range`);
  }
  const held = value as Record<string, unknown>;
  const unknown = Object.keys(held).filter((key) => !PLACE_FIELDS.includes(key)).sort(byCodePoint);
  if (unknown.length > 0) {
    throw refuse(read, index, repository, `its place holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a place holds ${PLACE_FIELDS.join(', ')}`);
  }
  const range = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    const part = held[field];
    if (typeof part !== 'number' || !Number.isInteger(part) || part < 0) {
      throw refuse(read, index, repository, `its place's ${field} ${JSON.stringify(part)} is no line or column: a range is whole numbers from 0`);
    }
    range[field] = part;
  }
  if (range.startLine < 1) {
    throw refuse(read, index, repository, `its place starts on line ${range.startLine}: lines are counted from one`);
  }
  if (range.endLine < range.startLine) {
    throw refuse(read, index, repository, `its place ends on line ${range.endLine} and starts on line ${range.startLine}: a range's end is never before its start`);
  }
  if (range.endLine === range.startLine && range.endColumn < range.startColumn) {
    throw refuse(read, index, repository, `its place ends at column ${range.endColumn} of line ${range.endLine} and starts at column ${range.startColumn}: a range's end is never before its start`);
  }
  return range;
}

// ---- the clustering -------------------------------------------------------

/** One seed of the clustering: a package or a build target, and the folder its manifest stands for. */
interface Seed {
  readonly name: string;
  readonly folder: string;
  /** The form the module carries: the package's own, `build-target` or `package`. */
  readonly seed: ModuleSeed;
  /** The manifest that declares it, used to name a module whose package name another seed shares. */
  readonly manifest: string;
}

/** One cluster of the repository's tree, before its fact id is computed: its name inside its parent, its own files and its children. */
interface ClusterTree {
  readonly name: string;
  readonly seed: ModuleSeed;
  /** The file ids standing directly in this cluster, in code point order. */
  readonly files: readonly string[];
  readonly children: readonly ClusterTree[];
}

/** What the clustering made of one repository: its top-level modules and what it could not read whole. */
interface Clustering {
  readonly trees: readonly ClusterTree[];
  readonly gaps: readonly CoverageGap[];
}

/** The folder a path stands in; `''` at the repository root. */
function folderOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** The folder one segment below a folder. */
function below(folder: string, segment: string): string {
  return folder === '' ? segment : `${folder}/${segment}`;
}

/** The path segment a path stands in one level below a folder; `undefined` where the path stands directly in the folder. */
function segmentAfter(path: string, folder: string): string | undefined {
  if (folder !== '' && !path.startsWith(`${folder}/`)) return undefined;
  const rest = folder === '' ? path : path.slice(folder.length + 1);
  const at = rest.indexOf('/');
  return at < 0 ? undefined : rest.slice(0, at);
}

/** Whether a seed's folder holds a path: the repository root holds everything, and a folder holds what stands under it. */
function holds(folder: string, path: string): boolean {
  return folder === '' || path.startsWith(`${folder}/`);
}

/**
 * The seeds of one repository, in the order that decides which seed a file
 * belongs to: the longest folder first, so the innermost package holds its own
 * files; then the manifest's path in code point order, so two seeds of one
 * folder (a `package.json` beside a `go.mod`) are told apart by a rule and not
 * by the order a read answered them. A `workspace` is no seed — it holds the
 * packages of its folders, and the schema's seeds are `package` and
 * `build-target` — and a package whose fact names no manifest stands for no
 * folder: both are named in the unit's coverage.
 */
function seedsOf(packages: readonly PublishedPackageRow[], gaps: CoverageGap[]): readonly Seed[] {
  const seeds: Seed[] = [];
  for (const pkg of packages) {
    if (pkg.form === 'workspace') {
      gaps.push({ what: `the package ${JSON.stringify(pkg.name)} is a workspace: a workspace holds the packages of its folders and is no seed of a module`, reason: 'unsupported' });
      continue;
    }
    if (pkg.manifest === undefined) {
      gaps.push({ what: `the package ${JSON.stringify(pkg.name)} names no manifest: it stands for no folder of the tree, so no module is seeded from it`, reason: 'unsupported' });
      continue;
    }
    seeds.push({ name: pkg.name, folder: folderOf(pkg.manifest), seed: pkg.form, manifest: pkg.manifest });
  }
  return seeds.sort((left, right) => right.folder.length - left.folder.length
    || byCodePoint(left.manifest, right.manifest)
    || byCodePoint(left.name, right.name));
}

/**
 * One repository clustered: the seeds' folders and the repository's own files
 * grouped, each group split by folder while it holds more files than the size
 * threshold, and each cluster's children grouped while there are more of them
 * than the fan-in bound (0026's "else an intermediate grouping level").
 */
function clusterRepository(input: {
  readonly repository: string;
  readonly packages: readonly PublishedPackageRow[];
  readonly files: readonly PublishedFileRow[];
  readonly settings: ModuleSettings;
}): Clustering {
  const gaps: CoverageGap[] = [];
  const seeds = seedsOf(input.packages, gaps);
  const bySeed = new Map<Seed, PublishedFileRow[]>();
  const unseeded: PublishedFileRow[] = [];
  for (const file of input.files) {
    const seed = seeds.find((candidate) => holds(candidate.folder, file.path));
    if (seed === undefined) {
      unseeded.push(file);
      continue;
    }
    const held = bySeed.get(seed) ?? [];
    held.push(file);
    bySeed.set(seed, held);
  }
  const named: { readonly base: string; readonly marker: string; readonly tree: () => ClusterTree }[] = [];
  for (const seed of seeds) {
    const held = bySeed.get(seed) ?? [];
    if (held.length === 0) {
      // A seed that holds no file seeds no module: a module of nothing is a
      // boundary no later stage could refine, and the graph holds its package
      // fact already. It is named in the coverage rather than dropped.
      gaps.push({ what: `${seed.manifest}:1 the package ${JSON.stringify(seed.name)} declares no file under ${JSON.stringify(seed.folder === '' ? '.' : seed.folder)}: no module is seeded from it`, reason: 'unsupported' });
      continue;
    }
    named.push({ base: seed.name, marker: seed.manifest, tree: () => clusterFolder(seed.name, seed.folder, held, seed.seed, input.settings, gaps) });
  }
  if (unseeded.length > 0) {
    named.push({
      base: input.repository,
      marker: 'the repository itself',
      tree: () => clusterFolder(input.repository, '', unseeded, 'cluster', input.settings, gaps),
    });
  }
  // One name among one parent's children is one module: where two seeds carry
  // one package name, each says which manifest it came from, so the cluster's
  // fact is one node and not two facts with one id. The root cluster names its
  // own marker for the same reason.
  const counts = new Map<string, number>();
  for (const entry of named) counts.set(entry.base, (counts.get(entry.base) ?? 0) + 1);
  const trees = named.map((entry) => (counts.get(entry.base) ?? 0) === 1
    ? entry.tree()
    : renameTop(entry.tree(), `${entry.base} (${entry.marker})`));
  return { trees, gaps };
}

/** A top-level cluster under another name, its children as they were. */
function renameTop(tree: ClusterTree, name: string): ClusterTree {
  return { ...tree, name };
}

/** The gap one cluster over the size threshold names: the folder, how many files stand directly in it, and the threshold. */
function tooLarge(folder: string, files: number, threshold: number): CoverageGap {
  return {
    what: `${folder === '' ? '.' : folder}:1 ${files} files stand directly in this folder and the size threshold is ${threshold}: the cluster is not split further`,
    reason: 'too-large',
  };
}

/**
 * One folder's files as a cluster: the files standing directly in it stay here,
 * and while the cluster holds more files than the size threshold each folder
 * below it is a cluster of its own, split by the same rule. A cluster still over
 * the threshold with no folder left to split by is named in the gaps and kept
 * whole, never cut at a boundary the tree does not have.
 */
function clusterFolder(name: string, folder: string, files: readonly PublishedFileRow[], seed: ModuleSeed, settings: ModuleSettings, gaps: CoverageGap[]): ClusterTree {
  const own = files.filter((file) => segmentAfter(file.path, folder) === undefined).map((file) => file.id).sort(byCodePoint);
  if (files.length <= settings.sizeThreshold) return { name, seed, files: files.map((file) => file.id).sort(byCodePoint), children: [] };
  const groups = new Map<string, PublishedFileRow[]>();
  for (const file of files) {
    const segment = segmentAfter(file.path, folder);
    if (segment === undefined) continue;
    const held = groups.get(segment) ?? [];
    held.push(file);
    groups.set(segment, held);
  }
  if (groups.size === 0) {
    gaps.push(tooLarge(folder, files.length, settings.sizeThreshold));
    return { name, seed, files: own, children: [] };
  }
  const children: ClusterTree[] = [];
  for (const segment of [...groups.keys()].sort(byCodePoint)) {
    children.push(clusterFolder(segment, below(folder, segment), groups.get(segment) ?? [], 'cluster', settings, gaps));
  }
  // The files standing directly in the folder stay in the cluster, and there is
  // no folder left to split them into: a cluster whose own files are still over
  // the threshold says so, rather than standing as a module larger than the
  // bound in a coverage that calls it whole.
  if (own.length > settings.sizeThreshold) gaps.push(tooLarge(folder, own.length, settings.sizeThreshold));
  return { name, seed, files: own, children: groupedChildren(children, settings.maxFanIn) };
}

/**
 * A cluster's children, grouped while there are more of them than the fan-in
 * bound: 0026 bounds a module's fan-in at about fifty children, and the bound is
 * held by an intermediate level — a group of at most the bound, named `part-1`,
 * `part-2` and so on in the code point order its children stand in, so the name
 * is the group's own and never depends on how many groups the folder happened to
 * need. A group of groups is grouped again, so no module ever has more than the
 * bound of children however wide the folder is.
 */
function groupedChildren(children: readonly ClusterTree[], maxFanIn: number): readonly ClusterTree[] {
  if (maxFanIn < MIN_MAX_FAN_IN) throw new Error(`the modules stage's configuration holds ${JSON.stringify(maxFanIn)} as its maxFanIn, and a bound below ${MIN_MAX_FAN_IN} cannot group a module's children: the value the registry judged is the value run with`);
  if (children.length <= maxFanIn) return children;
  const grouped: ClusterTree[] = [];
  for (let at = 0; at < children.length; at += maxFanIn) {
    const chunk = children.slice(at, at + maxFanIn);
    grouped.push({ name: `part-${grouped.length + 1}`, seed: 'cluster', files: [], children: chunk });
  }
  return groupedChildren(grouped, maxFanIn);
}

// ---- the ranking ----------------------------------------------------------

/** One node of the ranked graph, by its fact id, with the edges that leave it. */
interface RankedNode {
  readonly id: string;
  readonly out: { readonly to: number; readonly weight: number }[];
  weight: number;
}

/** What one PageRank answered: each node's share of the vector, and the sum of them all. */
interface Ranking {
  readonly rankOf: ReadonlyMap<string, number>;
  readonly total: number;
}

/**
 * PageRank over the repository's own graph (0026's "importance by PageRank").
 *
 * The nodes are every file and every symbol the reads answered, in code point
 * order of their ids, so the walk is the same arithmetic in the same order in
 * every run. The edges are the resolved ones the graph holds — an `import`
 * between two files, a `call`, a `reference` or an `inherits` between two
 * symbols, weighted by the sites stage 4 folded into it — and the declaration
 * that a file holds its symbol, so a file's rank reaches the symbols it
 * declares. Damping is 0.85: a node's share is the teleport part, one part in
 * `1/N` of it, plus what the nodes pointing at it give, and a node that points
 * at nothing spreads what it holds over the whole graph, which is what keeps the
 * vector a distribution of one whole. The walk stops when no node moved by more
 * than 1e-12, and after 100 turns at the most.
 *
 * An edge whose end names no node of the reads is refused rather than dropped: an
 * end is a fact the graph holds, and a rank computed past one would be a
 * smaller graph in silence.
 */
function rankNodes(input: {
  readonly repository: string;
  readonly files: readonly PublishedFileRow[];
  readonly symbols: readonly PublishedSymbolRow[];
  readonly edges: readonly ResolvedEdgeRow[];
}): Ranking {
  const ids = [...input.files.map((file) => file.id), ...input.symbols.map((symbol) => symbol.id)].sort(byCodePoint);
  const nodes: RankedNode[] = ids.map((id) => ({ id, out: [], weight: 0 }));
  const index = new Map<string, number>(ids.map((id, at) => [id, at]));
  const link = (from: string, to: string, weight: number, what: string): void => {
    const at = index.get(from);
    const into = index.get(to);
    if (at === undefined || into === undefined) {
      const absent = at === undefined ? from : to;
      throw new Error(`the read ${resolvedEdgesRead(input.repository)} answered ${what}, and ${JSON.stringify(absent)} is no node of the reads ${publishedFilesRead(input.repository)} and ${publishedSymbolsRead(input.repository)}: an edge's ends are facts this repository's graph holds`);
    }
    nodes[at]?.out.push({ to: into, weight });
    nodes[at]!.weight += weight;
  };
  for (const edge of input.edges) link(edge.from, edge.to, edge.weight, `a ${edge.kind} edge`);
  // A file declares its symbols: the rank it holds reaches the symbols it holds.
  const fileByPath = new Map<string, PublishedFileRow>(input.files.map((file) => [file.path, file]));
  for (const symbol of input.symbols) {
    const file = fileByPath.get(symbol.file);
    if (file === undefined) {
      throw new Error(`the read ${publishedSymbolsRead(input.repository)} answered the symbol ${symbol.id} of ${symbol.file}, and the read ${publishedFilesRead(input.repository)} answered no file there: a symbol is declared in a file of the tree`);
    }
    link(file.id, symbol.id, 1, `the symbol ${symbol.id}`);
  }
  for (const node of nodes) node.out.sort((left, right) => left.to - right.to || left.weight - right.weight);
  return pageRank(nodes);
}

/** The walk itself: one turn's vector from the last, until nothing moves further than `RANK_EPSILON`. */
function pageRank(nodes: readonly RankedNode[]): Ranking {
  const count = nodes.length;
  if (count === 0) return { rankOf: new Map(), total: 0 };
  const teleport = (1 - DAMPING) / count;
  const dangling = nodes.map((node, at) => (node.weight === 0 ? at : -1)).filter((at) => at >= 0);
  let rank = nodes.map(() => 1 / count);
  for (let turn = 0; turn < RANK_MAX_TURNS; turn += 1) {
    const next = nodes.map(() => teleport);
    let loose = 0;
    for (const at of dangling) loose += rank[at] ?? 0;
    const spread = (DAMPING * loose) / count;
    for (let at = 0; at < count; at += 1) next[at] = (next[at] ?? 0) + spread;
    for (let at = 0; at < count; at += 1) {
      const weight = nodes[at]?.weight ?? 0;
      if (weight === 0) continue;
      const given = rank[at] ?? 0;
      for (const edge of nodes[at]?.out ?? []) next[edge.to] = (next[edge.to] ?? 0) + (DAMPING * given * edge.weight) / weight;
    }
    let moved = 0;
    for (let at = 0; at < count; at += 1) moved = Math.max(moved, Math.abs((next[at] ?? 0) - (rank[at] ?? 0)));
    rank = next;
    if (moved <= RANK_EPSILON) break;
  }
  const rankOf = new Map<string, number>();
  let total = 0;
  nodes.forEach((node, at) => {
    const share = rank[at] ?? 0;
    rankOf.set(node.id, share);
    total += share;
  });
  return { rankOf, total };
}

/** A rank as it is written: twelve decimals, so the same graph answers the same number in every run and on every machine. */
function rankValue(share: number): number {
  const scale = 10 ** RANK_DECIMALS;
  const rounded = Math.round(share * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}

// ---- what the clustering writes -------------------------------------------

/** What the unit's writes are: every fact, how many modules stand, and how many gaps the coverage names. */
interface ClusteringWrite {
  readonly facts: readonly Fact[];
  readonly modules: number;
  readonly gaps: number;
}

/** What the reads answered, and what the clustering and the ranking made of them. */
interface ClusteringInput {
  readonly repository: string;
  readonly reader: SnapshotReader;
  readonly provenance: FactProvenance;
  readonly files: readonly PublishedFileRow[];
  readonly symbols: readonly PublishedSymbolRow[];
  readonly clustered: Clustering;
  readonly ranks: Ranking;
}

/**
 * The unit's facts: one `module` fact per cluster (its name inside its parent,
 * its seed, how many files and symbols stand under it, and the share of the
 * repository's rank they hold), the `contains` edges — a module holds its child
 * modules, the files standing in it, and the symbols those files declare — the
 * `file` and `symbol` facts with the rank this stage measured written onto them,
 * and one `coverage` fact for the repository. Every fact is written in code point
 * order of its id, so two runs of one graph write one draft in one order.
 */
function writeClustering(input: ClusteringInput): ClusteringWrite {
  const facts: Fact[] = [];
  const symbolsOf = new Map<string, PublishedSymbolRow[]>();
  const fileByPath = new Map<string, PublishedFileRow>(input.files.map((file) => [file.path, file]));
  for (const symbol of input.symbols) {
    const file = fileByPath.get(symbol.file);
    if (file === undefined) {
      throw new Error(`the read ${publishedSymbolsRead(input.repository)} answered the symbol ${symbol.id} of ${symbol.file}, and the read ${publishedFilesRead(input.repository)} answered no file there: a symbol is declared in a file of the tree`);
    }
    const held = symbolsOf.get(file.id) ?? [];
    held.push(symbol);
    symbolsOf.set(file.id, held);
  }
  const moduleIdOf = (tree: ClusterTree, parent: string | undefined): string => factId({
    kind: 'module',
    value: {
      repository: input.repository,
      name: tree.name,
      ...(parent === undefined ? {} : { parent }),
      seed: tree.seed,
    },
    provenance: input.provenance,
  });
  const visit = (tree: ClusterTree, parent: string | undefined): { readonly members: number; readonly share: number } => {
    const id = moduleIdOf(tree, parent);
    const children = tree.children.map((child) => visit(child, id));
    const ownSymbols = tree.files.flatMap((fileId) => symbolsOf.get(fileId) ?? []);
    let share = 0;
    let members = 0;
    for (const fileId of tree.files) {
      share += input.ranks.rankOf.get(fileId) ?? 0;
      members += 1;
    }
    for (const symbol of ownSymbols) {
      share += input.ranks.rankOf.get(symbol.id) ?? 0;
      members += 1;
    }
    for (const child of children) {
      share += child.share;
      members += child.members;
    }
    const importance = input.ranks.total === 0 ? 0 : rankValue(share / input.ranks.total);
    facts.push(makeNodeFact({
      kind: 'module',
      value: {
        repository: input.repository,
        name: tree.name,
        ...(parent === undefined ? {} : { parent }),
        seed: tree.seed,
        members,
        importance,
      },
      provenance: input.provenance,
      layer: 'extracted',
    }));
    if (parent !== undefined) {
      facts.push(makeEdgeFact({ kind: 'contains', value: { from: parent, to: id }, provenance: input.provenance, layer: 'extracted' }));
    }
    for (const fileId of tree.files) {
      facts.push(makeEdgeFact({ kind: 'contains', value: { from: id, to: fileId }, provenance: input.provenance, layer: 'extracted' }));
    }
    for (const symbol of ownSymbols) {
      facts.push(makeEdgeFact({ kind: 'contains', value: { from: id, to: symbol.id }, provenance: input.provenance, layer: 'extracted' }));
    }
    return { members, share };
  };
  for (const tree of input.clustered.trees) visit(tree, undefined);
  // The ranks the walk measured, written onto the facts they are about: the file
  // and symbol facts stages 1, 3 and 4 published, one id each, with `importance`.
  for (const file of input.files) {
    const importance = rankValue(input.ranks.rankOf.get(file.id) ?? 0);
    facts.push(makeNodeFact({
      kind: 'file',
      value: { ...file.value, path: repositoryPath(file.path), importance },
      provenance: { ...input.provenance, place: { file: repositoryPath(file.path), range: file.place } },
      layer: 'extracted',
    }));
  }
  for (const symbol of input.symbols) {
    const importance = rankValue(input.ranks.rankOf.get(symbol.id) ?? 0);
    facts.push(makeNodeFact({
      kind: 'symbol',
      value: { ...symbol.value, file: repositoryPath(symbol.file), importance },
      provenance: { ...input.provenance, place: { file: repositoryPath(symbol.file), range: symbol.place } },
      layer: 'extracted',
    }));
  }
  facts.push(coverageOf(input));
  return { facts: uniqueFacts(facts), modules: countModules(facts), gaps: input.clustered.gaps.length };
}

/** How many `module` facts the unit wrote. */
function countModules(facts: readonly Fact[]): number {
  return facts.filter((fact) => fact.kind === 'module').length;
}

/**
 * The unit's facts, each once, in code point order of its id. Two facts of one
 * id are one fact (0026), and a unit that computed two of them has computed a
 * cluster twice under one name: refused rather than published once of the two.
 */
function uniqueFacts(facts: readonly Fact[]): readonly Fact[] {
  const byId = new Map<string, Fact>();
  for (const fact of facts) {
    const held = byId.get(fact.id);
    if (held !== undefined) {
      throw new Error(`the modules stage computed two ${held.kind} facts of the id ${fact.id} for one repository: a fact's id is its identity, so two of one id are one fact, and this unit read the graph twice under one name`);
    }
    byId.set(fact.id, fact);
  }
  return [...byId.values()].sort((left, right) => byCodePoint(left.id, right.id));
}

/** The scopes one unit of this stage read, in code point order, each once: what its coverage says it read. */
const READ_SCOPES: readonly string[] = ['calls', 'files', 'imports', 'inherits', 'packages', 'references', 'symbols'];

/**
 * One repository's coverage: the scopes the unit read, and every gap the
 * clustering named — a package that stood for no folder, a workspace, a cluster
 * too large to split further — each with the reason 0004's coverage gives it. A
 * gap is never a claim of absence (0005): a complete coverage is the only ground
 * for one, and a gap makes it incomplete.
 */
function coverageOf(input: ClusteringInput): Fact {
  const unread = [...input.clustered.gaps]
    .map((gap) => ({ what: gap.what, reason: gap.reason as CoverageGapReason }))
    .sort((left, right) => byCodePoint(left.what, right.what) || byCodePoint(left.reason, right.reason));
  const scope = factId({ kind: 'repository', value: { repository: input.repository, form: input.reader.form }, provenance: input.provenance });
  return makeNodeFact({
    kind: 'coverage',
    value: {
      repository: input.repository,
      scope,
      complete: unread.length === 0,
      read: [...READ_SCOPES],
      unread,
    },
    provenance: input.provenance,
    layer: 'extracted',
  });
}
