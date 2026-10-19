/**
 * The reads the fill's deterministic stages make of the product graph, answered
 * from the fill's own fact store (madarch-tzte.21.8; decision 0026's eight
 * stages, decision 0027's host).
 *
 * **What asks, and what answers.** A stage's plan and each of its units read the
 * product graph by calling `graph.query(text)` with the JSON document its own
 * builder writes — `publishedTreeRead`, `publishedManifestsRead`,
 * `publishedSymbolsRead` (of the syntax-and-resolution and of the modules
 * stage), `publishedImportsRead`, `publishedGapsRead`, `publishedReadsRead`,
 * `compilerIndexRead`, `publishedPackagesRead`, `publishedFilesRead`,
 * `resolvedEdgesRead`, `publishedDocumentsRead` — and the history stage's units
 * read through SQL of its own (`commitsHeldQuery`, `coverageHeldQuery`). This module is that seam for a run whose facts are the
 * fill's own: the rows come from `fill_fact` and `fill_fact_holding`
 * (`fact-store.ts`), which is the store a publication's own transaction writes.
 *
 * **The rows are built here, in JavaScript.** Each read answers the exact keys
 * the consuming stage's own reader demands (`publishedTreeRows`,
 * `publishedManifests`, `publishedDocuments`, `publishedImportRows` and
 * `publishedGapRows` of `syntax-specifiers.ts`, `publishedReadRows`, `symbolRows`
 * and `indexRows` of `semantic-resolution.ts`, `packageRows`, `fileRows`,
 * `symbolRows` and `edgeRows` of `modules.ts`): a row is built from the fact's
 * own value, and a key the fact does not hold is left out — never written as
 * null — because those readers refuse a key they do not define and a key a blob,
 * a manifest or a count holds as null. Building rows in SQL
 * (`jsonb_build_object`) would write exactly those nulls.
 *
 * **Order.** Every answer is in code point order of the fact id, so one graph
 * answers one set of rows in one order: the orchestrator records a read's
 * membership and compares it at revalidation (`recordUnitRead` and
 * `readMembership`, `orchestrator-store.ts`), and an answer whose order moved
 * with the database's collation would make every unit that read it stale. One
 * fact that answers several rows (a coverage's gaps, a file's... a file answers
 * one) answers them in code point order of what each row names.
 *
 * **Which facts answer which read.** The filter of each read is the stage's own
 * words, and each row is the shape its reader demands:
 *
 * - `stage-1-published-tree`: the `file` and `directory` facts of the repository.
 * - `stage-2-published-manifests`: the `coverage` facts the build-and-
 *   configuration stage published whose scope is a repository path — the manifest
 *   paths stage 2 already digested.
 * - `stage-3-published-symbols`: the `symbol` facts declared in one file, with
 *   the declaration's range flattened out of the fact's `provenance.place.range`.
 * - `stage-3-coverage-gaps`: the gaps of the syntax stage's `coverage` of a
 *   repository, one row per gap, each naming the file it stands in. Stage 3's own
 *   plan reads it beside stage 4's (madarch-tzte.21.9), and so the next read: a
 *   name says who first asked for an answer, not who may.
 * - `stage-4-published-imports`: the `import` edges one repository's files
 *   wrote whose target is a file fact's id, the graph holding a `file` fact for
 *   it or not (a run that resumes after a retraction and before its importers
 *   were read again).
 * - `stage-4-published-reads`: the resolution stage's own `coverage`, with the
 *   files each resolution read.
 * - `stage-4-compiler-index`: no rows at all. This build wires no compiler index,
 *   and the stage's own words say what a wiring without one answers: nothing.
 *   The unit's coverage names the index it did not have (`resolution-facts.ts`),
 *   so a silent empty answer here is not a silence about the file.
 * - `stage-5-published-packages`: the `package` facts of the repository, seeds
 *   and workspaces alike (the clustering drops a workspace itself).
 * - `stage-5-published-files` and `stage-5-published-symbols`: the `file` and
 *   `symbol` facts of the repository, each with its whole value and its place.
 * - `stage-5-resolved-edges`: the `import` edges between two files and the
 *   `call`, `reference` and `inherits` edges between two symbols of the
 *   repository, with the site count where the edge's value carries one.
 * - `stage-6-published-documents`: the `document` facts of the repository.
 *
 * **Which repository a fact belongs to.** Every kind these reads answer carries
 * `value.repository`, and a read answers the facts whose value names the
 * repository the read was made for — except the four edge kinds, whose values
 * name their two ends and no repository at all (`import`, `call`, `reference`
 * and `inherits`). An edge belongs to a repository when the end its reader
 * filters by stands among that repository's own facts of the kind the edge joins
 * — the *importer* for an `import`, and *both* ends for the `call`, `reference`
 * and `inherits` edges of the modules stage, which is the same rule the
 * consuming stage applies to the rows (`planResolution` maps an edge's ends
 * through the paths the tree read holds). An `import` edge's own target may be
 * one the repository no longer holds: a run whose stages retracted a deleted
 * file before its importers were read again holds such an edge, and a plan that
 * cannot see it cannot repair it (madarch-tzte.21.9). A stored path that is no
 * repository path, wherever a read answers one, is refused by name rather than
 * answered: a fact the store holds damaged is named, never answered as a row the
 * stage would then plan a wrong unit from.
 *
 * **Which stage published a coverage.** A repository's coverages are told apart
 * by the stage that published them (`fill_fact_holding.stage_id`) and not by
 * their reader's own name: `coverage`'s identity names the reader's system
 * (`FACT_KINDS.coverage`), which tells stage 3 (tree-sitter), stage 4
 * (madarch-resolution) and stage 5 (fill-stage-5) apart but cannot tell stage
 * 2's coverage of a manifest from stage 0's coverage of the same repository —
 * both read through git. So a coverage read filters by the stage, then reads the
 * scope the read's own words name.
 *
 * **A stage's own SQL, through a view named `fact`.** The history stage does not
 * use the JSON grammar: its three reads are SQL that names the table `fact`
 * (`src/fill/stages/history.ts`, which wrote that shape as its proposal for the
 * fact storage), selecting `repository` and `commit` out of the value for a
 * pinned snapshot, `commit` and `value` for a commit, and the `value` of one
 * scope's coverage. `createStageReadSchema` creates that view over `fill_fact`,
 * with the columns of a stored fact (id, kind, schema_version, layer, status,
 * provenance, value) and the three columns read out of the value (repository,
 * commit, scope). The name is the stage's own: the SQL text says `fact`, and a
 * view is what makes that text run against the fill's tables. Nothing else
 * creates it, and creating it again replaces the view with the same one.
 *
 * **Anything else goes to the graph reader.** The graph-read grammar of
 * `graph-reads.ts` (the unit tools' `fact`, `facts`, `adjacent`, `held`,
 * `facts-with`, `drafts` and `span` reads) and a stage's own SQL are answered by
 * `createFactGraphReader` over the same database, snapshot and executor: one
 * seam, two grammars, and no second reading of either.
 */
import { byCodePoint } from '../model/order.js';
import { ID_PATTERN } from '../model/schema.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import { FACT_STORE_TABLES, createFactStoreSchema, type FactStoreDatabase } from './fact-store.js';
import { isRepositoryPath, repositoryPath, type RepositoryPath } from './facts.js';
import { here, raise, withLocation } from './fsm-core.js';
import { GRAPH_READ_KINDS, createFactGraphReader, type GraphSnapshotSource } from './graph-reads.js';
import { BUILD_CONFIGURATION_STAGE_ID, PUBLISHED_MANIFESTS_READ } from './stages/build-configuration.js';
import { PUBLISHED_DOCUMENTS_READ } from './stages/document-index.js';
import { PUBLISHED_TREE_READ } from './stages/inventory.js';
import { PUBLISHED_FILES_READ, PUBLISHED_PACKAGES_READ, PUBLISHED_SYMBOLS_READ as MODULE_SYMBOLS_READ, RESOLVED_EDGES_READ } from './stages/modules.js';
import {
  COMPILER_INDEX_READ, PUBLISHED_READS_READ,
  PUBLISHED_SYMBOLS_READ as RESOLUTION_SYMBOLS_READ, SEMANTIC_RESOLUTION_STAGE_ID,
} from './stages/semantic-resolution.js';
import { PUBLISHED_GAPS_READ, PUBLISHED_IMPORTS_READ } from './stages/syntax-specifiers.js';
import { SYNTAX_STAGE_ID } from './stages/syntax.js';

// ---------------------------------------------------------------------------------------------
// The interface a wiring codes against
// ---------------------------------------------------------------------------------------------

/**
 * Every read name this module answers, by the stage module whose own builder
 * writes the text, and in code point order: the order is what the list is sorted
 * into here, so it is the order of the names and not a hand-kept one.
 */
const STAGE_READ_NAME_LIST = [
  COMPILER_INDEX_READ,
  MODULE_SYMBOLS_READ,
  PUBLISHED_DOCUMENTS_READ,
  PUBLISHED_FILES_READ,
  PUBLISHED_GAPS_READ,
  PUBLISHED_IMPORTS_READ,
  PUBLISHED_MANIFESTS_READ,
  PUBLISHED_PACKAGES_READ,
  PUBLISHED_READS_READ,
  PUBLISHED_TREE_READ,
  RESOLUTION_SYMBOLS_READ,
  RESOLVED_EDGES_READ,
] as const;

/** One read name of this module's own grammar. */
type StageReadName = (typeof STAGE_READ_NAME_LIST)[number];

/** Every read name this module answers, in code point order. */
export const STAGE_READ_NAMES: readonly string[] = [...STAGE_READ_NAME_LIST].sort(byCodePoint);

/** Whether a name is one this module answers. */
function isStageReadName(name: unknown): name is StageReadName {
  return typeof name === 'string' && (STAGE_READ_NAME_LIST as readonly string[]).includes(name);
}

/** One read of this module's grammar: the read a stage's own builder named, and what it reads. */
export interface StageReadRequest {
  readonly read: string;
  /** The product's own name for the repository the read is made for (`ID_PATTERN`). */
  readonly repository: string;
  /** The repository path the read names, where the read names one. */
  readonly path?: string;
}

/** The reads that name one file of the repository, and the reads that name none. */
const PATH_READS: readonly string[] = [COMPILER_INDEX_READ, RESOLUTION_SYMBOLS_READ];

/** The keys a read of one kind holds: the read's own name, the repository, and a path where the read names one. */
function keysOf(read: StageReadName): readonly string[] {
  return PATH_READS.includes(read) ? ['path', 'read', 'repository'] : ['read', 'repository'];
}

/**
 * The read a text names, or null when the text is another reader's own text: a
 * text that does not open a JSON object is a stage's SQL, and a JSON object that
 * names one of the graph-read grammar's own read kinds (`graph-reads.ts`) is
 * that grammar's. A text that opens a JSON object and names something else is
 * refused by name — the text, the name it carries, the read names this module
 * answers — never answered as SQL, and never answered by a read nobody asked
 * for.
 */
export function parseStageRead(text: string): StageReadRequest | null {
  const at = here();
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    raise(`${at}: the text ${JSON.stringify(text)} opens a JSON object and does not parse as one, so it is no read this module answers: the reads of the stages are ${STAGE_READ_NAMES.join(', ')} (${(error as Error).message})`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    raise(`${at}: the read ${JSON.stringify(text)} is ${Array.isArray(value) ? 'a list' : typeof value}, not a read: a read of the stages names its kind (${STAGE_READ_NAMES.join(', ')}) and the repository it reads`);
  }
  const fields = value as Record<string, unknown>;
  const kind = fields['read'];
  if (!isStageReadName(kind)) {
    // The graph-read grammar's own reads are its reader's business: this module
    // hands them on rather than refusing a text another reader wrote.
    if (typeof kind === 'string' && (GRAPH_READ_KINDS as readonly string[]).includes(kind)) return null;
    raise(`${at}: the read ${JSON.stringify(text)} names ${shown(kind)}: the reads of the stages are ${STAGE_READ_NAMES.join(', ')}, and a text that names none of them is no read of a stage`);
  }
  return requestOf(kind, fields, text, at);
}

/** One read's own text, built again from what it names, for a refusal to show. */
function readText(request: StageReadRequest): string {
  return JSON.stringify({ read: request.read, repository: request.repository, ...(request.path === undefined ? {} : { path: request.path }) });
}

/** One read of a known kind, its fields read against what that read names: the repository, and the path where it names one. */
function requestOf(kind: StageReadName, fields: Record<string, unknown>, text: string, at: string): StageReadRequest {
  const keys = keysOf(kind);
  const unknown = Object.keys(fields).filter((key) => !keys.includes(key)).sort(byCodePoint);
  if (unknown.length > 0) {
    raise(`${at}: the read ${JSON.stringify(text)} holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a read of "${kind}" holds ${keys.join(', ')}: an answer is built from what a read names and from nothing else`);
  }
  const repository = fields['repository'];
  if (typeof repository !== 'string' || !ID_PATTERN.test(repository)) {
    raise(`${at}: the read ${JSON.stringify(text)} names the repository ${shown(repository)}: the product's own name for a repository, like "orders-api", never a path, a URL or a branch`);
  }
  if (!PATH_READS.includes(kind)) return { read: kind, repository };
  const path = fields['path'];
  if (typeof path !== 'string' || !isRepositoryPath(path)) {
    raise(`${at}: the read ${JSON.stringify(text)} names the path ${shown(path)}: a path from the repository's root, "/"-separated at every depth, with no "." or ".." leg`);
  }
  return { read: kind, repository, path };
}

/** What one read answers from: the process's database owner, the run's pinned snapshot, and a transaction a caller already opened. */
export interface StageReadsOptions {
  /** The owner the fill's tables stand in (`Pick<DatabaseOwner, 'transaction'>`). */
  readonly database: FactStoreDatabase;
  /** The run's pinned repositories, which the delegated span read answers from. */
  readonly snapshot: GraphSnapshotSource;
  /**
   * A transaction the caller already opened (a publication's own recheck): every
   * statement this reader makes runs on it when it is given, because the owner
   * refuses a second transaction on one connection.
   */
  readonly executor?: SqlExecutor;
}

/** A value a refusal shows: JSON's own way, and `nothing` for one that is not there. */
function shown(value: unknown): string {
  if (value === undefined) return 'nothing';
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

// ---------------------------------------------------------------------------------------------
// The stage's own SQL: the `fact` view
// ---------------------------------------------------------------------------------------------

/** The view a stage's own SQL reads through; the history stage's own queries name it. */
export const STAGE_FACT_VIEW = 'fact';

/**
 * The view: one row per stored fact, with the columns a fact is read by and the
 * three the history stage's queries read out of the value
 * (`commitsHeldQuery` reads `commit` and `value` of a commit, `coverageHeldQuery`
 * reads `value` and filters by `repository` and `scope`, and a snapshot's
 * `repository` and `commit` are what a query of its rows would read). `->>` is what makes
 * each of the three a text a query compares, and a fact whose value does not
 * carry one answers null there rather than a row that reads as a fact naming
 * nothing.
 */
const VIEW_SCHEMA = [
  `CREATE OR REPLACE VIEW ${STAGE_FACT_VIEW} AS
     SELECT f.id AS id,
            f.kind AS kind,
            f.schema_version AS schema_version,
            f.layer AS layer,
            f.status AS status,
            f.provenance AS provenance,
            f.value AS value,
            f.value->>'repository' AS repository,
            f.value->>'commit' AS commit,
            f.value->>'scope' AS scope
       FROM fill_fact f`,
];

/**
 * Creates the schema a stage's own SQL reads through: the fill's fact tables (the
 * store's own creation, idempotent, so a caller that has not created them yet is
 * not left with a view over a table nobody made) and the `fact` view over them.
 * Safe to call on every start of the process's owner, and to be called before a
 * run: a read cannot create it, since a read inside a publication's transaction
 * must write nothing.
 */
export async function createStageReadSchema(database: FactStoreDatabase): Promise<void> {
  const at = here();
  await createFactStoreSchema(database);
  await withLocation(at, `createStageReadSchema(${STAGE_FACT_VIEW})`, [...FACT_STORE_TABLES, STAGE_FACT_VIEW], async () => {
    await database.transaction('write', async (executor) => {
      for (const statement of VIEW_SCHEMA) await executor.query(statement);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------------

/** One row of an answer: the keys the consuming stage's own reader demands, and no others. */
type Row = Record<string, unknown>;

/** One stored fact as a read of these rows reads it: the columns the reads filter and build rows from. */
interface FactRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly value: unknown;
  readonly provenance: unknown;
}

/** The tables a read of the facts touches. */
const FACTS: readonly string[] = ['fill_fact'];

/** The tables a read of what one stage published touches: the fact, and the holding that names the stage that published it. */
const FACTS_AND_HOLDINGS: readonly string[] = FACT_STORE_TABLES;

/** A JSON column as a value: PostgreSQL drivers answer `jsonb` objects, and a text-encoded one is parsed. */
function column(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** A fact's own value, refused by name where the row holds something that is no value. */
function valueOf(fact: FactRow, at: string): Record<string, unknown> {
  const value = column(fact.value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    raise(`${at}: the stored fact ${fact.id} of kind "${fact.kind}" holds ${shown(value)} as its value, and this read builds its rows from a fact's own value: a fact's value is the object the schema reads`);
  }
  return value as Record<string, unknown>;
}

/** One object held under a key, refused by name where it is not one. */
function objectIn(value: Record<string, unknown>, key: string, fact: FactRow, at: string): Record<string, unknown> {
  const held = value[key];
  if (held === null || typeof held !== 'object' || Array.isArray(held)) {
    raise(`${at}: the stored fact ${fact.id} of kind "${fact.kind}" holds ${shown(held)} as its ${key}, and this read answers a row built from it: a fact's ${key} is an object`);
  }
  return held as Record<string, unknown>;
}

/**
 * The repository path a fact holds under a key, refused by name where it holds
 * something that is no repository path. A path the store holds damaged stops the
 * answer rather than being answered as a row: the consuming stage would plan a
 * unit from a path no tree holds.
 */
function pathIn(value: Record<string, unknown>, key: string, fact: FactRow, at: string): RepositoryPath {
  const held = value[key];
  if (typeof held !== 'string' || !isRepositoryPath(held)) {
    raise(`${at}: the stored fact ${fact.id} of kind "${fact.kind}" holds ${shown(held)} as its ${key}, which is no repository path: a path from the repository's root, "/"-separated at every depth, with no "." or ".." leg`);
  }
  return repositoryPath(held);
}

/**
 * The keys a row takes from a fact's own value, and no key the fact does not
 * hold: a key the value carries as null is left out, because the readers refuse a
 * null where they expect a blob, a manifest or a count, and a key the value does
 * not carry is refused by the reader itself wherever it is one the row must have.
 */
function fromValue(value: Record<string, unknown>, keys: readonly string[]): Row {
  const row: Row = {};
  for (const key of keys) {
    const held = value[key];
    if (held === undefined || held === null) continue;
    row[key] = held;
  }
  return row;
}

/**
 * The declaration range a fact stands at, flattened onto the row out of its own
 * provenance (`provenance.place.range`): the four parts a stage's symbol row
 * carries. A fact that carries no place is refused by name — a `file` or a
 * `symbol` fact stands at a place, and a row answered without one would read as a
 * declaration at no line at all.
 */
function rangeRow(fact: FactRow, at: string): Row {
  const provenance = column(fact.provenance);
  const held = provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance) ? (provenance as Record<string, unknown>)['place'] : undefined;
  if (held === null || typeof held !== 'object' || Array.isArray(held)) {
    raise(`${at}: the stored fact ${fact.id} of kind "${fact.kind}" carries no place (provenance.place), and this read answers the range the fact stands at: a ${fact.kind} fact stands at a file and a range`);
  }
  const place = held as Record<string, unknown>;
  const range = place['range'];
  if (range === null || typeof range !== 'object' || Array.isArray(range)) {
    raise(`${at}: the stored fact ${fact.id} of kind "${fact.kind}" carries no range (provenance.place.range), and this read answers the range the fact stands at`);
  }
  const parts = range as Record<string, unknown>;
  return { startLine: parts['startLine'], startColumn: parts['startColumn'], endLine: parts['endLine'], endColumn: parts['endColumn'] };
}

// ---------------------------------------------------------------------------------------------
// What the store answers
// ---------------------------------------------------------------------------------------------

/** The facts of one repository, by kind, in code point order of their id. */
async function repositoryFacts(executor: SqlExecutor, kinds: readonly string[], repository: string, file?: string): Promise<readonly FactRow[]> {
  // The file is a filter of the store's own where the read names one: the
  // resolution stage reads one file's symbols once per unit and once per file
  // that unit imports, so a scan of every symbol per read is what a run pays.
  const { rows } = await executor.query<FactRow>(
    `SELECT f.id, f.kind, f.value, f.provenance
       FROM fill_fact f
      WHERE f.kind = ANY($1::text[]) AND f.value->>'repository' = $2
        AND ($3::text IS NULL OR f.value->>'file' = $3)`,
    [kinds, repository, file ?? null],
  );
  return inIdOrder(rows);
}

/**
 * The `coverage` facts one stage published for one repository, in code point
 * order of their id. The stage is read from the holding that published the fact
 * (`fill_fact_holding.stage_id`) and not from the fact's reader: one run's stages
 * read the same repository through the same git reader, so the reader's own name
 * tells three of them apart and not the fourth (see the module doc).
 */
async function stageCoverageFacts(executor: SqlExecutor, stage: string, repository: string): Promise<readonly FactRow[]> {
  const { rows } = await executor.query<FactRow>(
    `SELECT DISTINCT f.id, f.kind, f.value, f.provenance
       FROM fill_fact f JOIN fill_fact_holding h ON h.id = f.id
      WHERE f.kind = 'coverage' AND h.stage_id = $1 AND f.value->>'repository' = $2`,
    [stage, repository],
  );
  return inIdOrder(rows);
}

/**
 * The `import` edges one repository's files wrote, in code point order of their
 * id. The importer must be a `file` fact of the repository; the target must be a
 * file fact's *id*, not the fact itself, and that is deliberate
 * (madarch-tzte.21.9): a run whose stage 1 has already retracted a deleted
 * target's `file` fact while its importers were not read again leaves an
 * `import` edge with nowhere to point, and only a read that answers the edge
 * lets a plan repair it. An edge to another repository's file is answered here
 * too, and the consuming plans tie it back to this repository's paths — an edge
 * they cannot tie is one they read the importer again for. An edge whose target
 * is no file fact's id at all — a `module:` or `package:` end, which the schema
 * allows for an `import` (`EDGE_END_KINDS.import`) though stage 3 writes none —
 * is no row of this read, because the two plans that read it plan file units and
 * would refuse such a row by name. A damaged `file:…` id is a row here and the
 * row reader refuses it, which is the module's own rule: a fact the store holds
 * damaged is named, never dropped.
 */
async function importEdgeFacts(executor: SqlExecutor, repository: string): Promise<readonly FactRow[]> {
  const { rows } = await executor.query<FactRow>(
    `SELECT f.id, f.kind, f.value, f.provenance
       FROM fill_fact f
      WHERE f.kind = 'import'
        AND f.value->>'from' IN (SELECT id FROM fill_fact WHERE kind = 'file' AND value->>'repository' = $1)
        AND f.value->>'to' LIKE 'file:%'`,
    [repository],
  );
  return inIdOrder(rows);
}

/** The resolved edges of one repository, in code point order of their id: the `import` edges between its files, and its `call`, `reference` and `inherits` edges between its symbols. */
async function resolvedEdgeFacts(executor: SqlExecutor, repository: string, symbolKinds: readonly string[]): Promise<readonly FactRow[]> {
  const { rows } = await executor.query<FactRow>(
    `SELECT f.id, f.kind, f.value, f.provenance
       FROM fill_fact f
      WHERE (f.kind = 'import'
             AND f.value->>'from' IN (SELECT id FROM fill_fact WHERE kind = 'file' AND value->>'repository' = $1)
             AND f.value->>'to' IN (SELECT id FROM fill_fact WHERE kind = 'file' AND value->>'repository' = $1))
         OR (f.kind = ANY($2::text[])
             AND f.value->>'from' IN (SELECT id FROM fill_fact WHERE kind = 'symbol' AND value->>'repository' = $1)
             AND f.value->>'to' IN (SELECT id FROM fill_fact WHERE kind = 'symbol' AND value->>'repository' = $1))`,
    [repository, symbolKinds],
  );
  return inIdOrder(rows);
}

/**
 * The three resolution edges, which join two symbols; an `import` joins two files
 * and the read answers it in its own branch. Together they are the four kinds the
 * modules stage's rank walks (`RESOLVED_EDGE_KINDS`, `modules.ts`), and this list
 * is named apart from that one because it is the half this branch answers.
 */
const SYMBOL_EDGE_KINDS: readonly string[] = ['call', 'inherits', 'reference'];

/** The facts of one answer in code point order of their id: the order every read answers in, whatever the database's collation is. */
function inIdOrder(facts: readonly FactRow[]): readonly FactRow[] {
  return [...facts].sort((left, right) => byCodePoint(left.id, right.id));
}

// ---- one read each --------------------------------------------------------

/** The tree the inventory's plan compares against: the `file` and `directory` facts of the repository. */
async function treeRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await repositoryFacts(executor, ['directory', 'file'], request.repository);
  return facts.map((fact) => {
    const value = valueOf(fact, at);
    return {
      kind: fact.kind,
      repository: request.repository,
      path: pathIn(value, 'path', fact, at),
      // A blob stands on a file and never on a folder: a row's blob is the file's
      // bytes, and a row reader refuses one on a folder.
      ...(fact.kind === 'file' ? fromValue(value, ['blob']) : {}),
    };
  });
}

/** The manifests stage 2 has already digested: its own `coverage` of a repository path, one row per manifest. */
async function manifestRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await stageCoverageFacts(executor, BUILD_CONFIGURATION_STAGE_ID, request.repository);
  return facts.map((fact) => ({
    kind: 'manifest',
    repository: request.repository,
    path: pathIn(valueOf(fact, at), 'scope', fact, at),
  }));
}

/** The symbols declared in one file, each with the range its declaration stands at. */
async function symbolOfFileRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const path = request.path;
  if (path === undefined) {
    raise(`${at}: the read ${readText(request)} names no path, and this read answers the symbols one file declares: a read of one file's symbols names the file`);
  }
  const facts = await repositoryFacts(executor, ['symbol'], request.repository, path);
  return facts.map((fact) => {
    const value = valueOf(fact, at);
    return {
      kind: 'symbol',
      file: pathIn(value, 'file', fact, at),
      id: fact.id,
      ...fromValue(value, ['qualifiedName', 'symbolKind']),
      ...rangeRow(fact, at),
    };
  });
}

/** What stage 3 could not tie to a node: the gaps of its own `coverage` of a repository, one row per gap. */
async function coverageGapRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await stageCoverageFacts(executor, SYNTAX_STAGE_ID, request.repository);
  const rows: Row[] = [];
  for (const fact of facts) {
    const value = valueOf(fact, at);
    const file = pathIn(value, 'scope', fact, at);
    const unread = value['unread'];
    if (unread === undefined || unread === null) continue;
    if (!Array.isArray(unread)) {
      raise(`${at}: the stored coverage ${fact.id} of the syntax stage holds ${shown(unread)} as its unread gaps, and this read answers one row per gap: a coverage's gaps are a list of records naming what could not be read`);
    }
    // The schema keeps a coverage's gaps in code point order of what they name
    // (`RECORD_LIST_FIELDS`, `facts.ts`); the answer is ordered here too, so a
    // stored list in another order answers the same rows.
    const gaps = [...unread].sort((left, right) => byCodePoint(whatOf(left), whatOf(right)));
    for (const gap of gaps) {
      if (gap === null || typeof gap !== 'object' || Array.isArray(gap)) {
        raise(`${at}: the stored coverage ${fact.id} of the syntax stage holds ${shown(gap)} among its gaps, and this read answers one row per gap: a gap is a record naming what the reader could not read`);
      }
      rows.push({ kind: 'coverage', file, ...fromValue(gap as Record<string, unknown>, ['what']) });
    }
  }
  return rows;
}

/** What one stored gap names, for a refusal and for the order of an answer: text that is not one is nobody's order, and is read by the stage's own reader when the row is answered. */
function whatOf(gap: unknown): string {
  return gap !== null && typeof gap === 'object' && !Array.isArray(gap) && typeof (gap as Record<string, unknown>)['what'] === 'string'
    ? (gap as Record<string, unknown>)['what'] as string
    : '';
}

/**
 * The imports a repository's files wrote, with the specifier each wrote. An
 * `import` fact whose value carries no specifier is no row of this read: the
 * reading stage refuses such a row (`publishedImportRows`, which names the
 * specifier it needs), and the read's own words are "the specifier each wrote",
 * so the row is left out here rather than answered as a shape the reader refuses.
 * An edge whose target the graph holds no `file` fact for is a row all the same:
 * it is the state a resumed run finds (see `importEdgeFacts`).
 */
async function importRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await importEdgeFacts(executor, request.repository);
  const rows: Row[] = [];
  for (const fact of facts) {
    const value = valueOf(fact, at);
    const specifier = value['specifier'];
    if (typeof specifier !== 'string' || specifier.trim() === '') continue;
    rows.push({ kind: 'import', ...fromValue(value, ['from', 'to', 'specifier']) });
  }
  return rows;
}

/** What the resolution stage's own last run read for each file of the repository. */
async function resolutionReadRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await stageCoverageFacts(executor, SEMANTIC_RESOLUTION_STAGE_ID, request.repository);
  return facts.map((fact) => {
    const value = valueOf(fact, at);
    return { kind: 'coverage', file: pathIn(value, 'scope', fact, at), ...fromValue(value, ['read']) };
  });
}

/**
 * The compiler index of one file: no rows. This build wires no compiler index
 * (`src/product/fill-stages.ts` registers the eight deterministic stages and no
 * indexer), and the resolution stage's own words say what a wiring without one
 * answers: nothing — the read exists as the seam a SCIP indexer would answer, and
 * the file's coverage names the index it did not have.
 */
async function compilerIndexRows(_executor: SqlExecutor, _request: StageReadRequest, _at: string): Promise<readonly Row[]> {
  return [];
}

/** The packages and build targets a repository's manifests declare. */
async function packageRowsOf(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await repositoryFacts(executor, ['package'], request.repository);
  return facts.map((fact) => ({ kind: 'package', ...fromValue(valueOf(fact, at), ['name', 'form', 'manifest']) }));
}

/** The `file` facts of the repository, each with its whole value and the place it stands at. */
async function publishedFileRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await repositoryFacts(executor, ['file'], request.repository);
  return facts.map((fact) => {
    const value = valueOf(fact, at);
    return { kind: 'file', path: pathIn(value, 'path', fact, at), id: fact.id, value, place: rangeRow(fact, at) };
  });
}

/** The `symbol` facts of the repository, each with its whole value and the place it is declared at. */
async function publishedSymbolRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await repositoryFacts(executor, ['symbol'], request.repository);
  return facts.map((fact) => {
    const value = valueOf(fact, at);
    return { kind: 'symbol', file: pathIn(value, 'file', fact, at), id: fact.id, value, place: rangeRow(fact, at) };
  });
}

/** The resolved edges of the repository: an `import` between two files, a `call`, `reference` or `inherits` between two symbols, with the count where the edge holds one. */
async function resolvedEdgeRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await resolvedEdgeFacts(executor, request.repository, SYMBOL_EDGE_KINDS);
  return facts.map((fact) => ({ kind: fact.kind, ...fromValue(valueOf(fact, at), ['from', 'to', 'count']) }));
}

/** The documents of the repository, each with the blob its bytes stood under. */
async function documentRows(executor: SqlExecutor, request: StageReadRequest, at: string): Promise<readonly Row[]> {
  const facts = await repositoryFacts(executor, ['document'], request.repository);
  return facts.map((fact) => {
    const value = valueOf(fact, at);
    return { kind: 'document', repository: request.repository, path: pathIn(value, 'path', fact, at), ...fromValue(value, ['blob']) };
  });
}

/** One read of this module's grammar, answered from the fill's own facts. */
interface StageAnswer {
  /** The tables the read touches, named when a database failure is reported. */
  readonly tables: readonly string[];
  readonly answer: (executor: SqlExecutor, request: StageReadRequest, at: string) => Promise<readonly Row[]>;
}

/** Every read this module answers, by the name the stage's own builder writes. */
const ANSWERS: { readonly [K in StageReadName]: StageAnswer } = {
  [COMPILER_INDEX_READ]: { tables: FACTS, answer: compilerIndexRows },
  [MODULE_SYMBOLS_READ]: { tables: FACTS, answer: publishedSymbolRows },
  [PUBLISHED_DOCUMENTS_READ]: { tables: FACTS, answer: documentRows },
  [PUBLISHED_FILES_READ]: { tables: FACTS, answer: publishedFileRows },
  [PUBLISHED_GAPS_READ]: { tables: FACTS_AND_HOLDINGS, answer: coverageGapRows },
  [PUBLISHED_IMPORTS_READ]: { tables: FACTS, answer: importRows },
  [PUBLISHED_MANIFESTS_READ]: { tables: FACTS_AND_HOLDINGS, answer: manifestRows },
  [PUBLISHED_PACKAGES_READ]: { tables: FACTS, answer: packageRowsOf },
  [PUBLISHED_READS_READ]: { tables: FACTS_AND_HOLDINGS, answer: resolutionReadRows },
  [PUBLISHED_TREE_READ]: { tables: FACTS, answer: treeRows },
  [RESOLUTION_SYMBOLS_READ]: { tables: FACTS, answer: symbolOfFileRows },
  [RESOLVED_EDGES_READ]: { tables: FACTS, answer: resolvedEdgeRows },
};

/** The answer to one read, or `undefined` where this module answers no read of that name. */
function answerTo(read: string): StageAnswer | undefined {
  return Object.hasOwn(ANSWERS, read) ? ANSWERS[read as StageReadName] : undefined;
}

// ---------------------------------------------------------------------------------------------
// The reader a stage is wired with
// ---------------------------------------------------------------------------------------------

/**
 * The reader the orchestrator's own seam takes: a read of this module's grammar
 * is answered from the fill's facts, and any other text is handed to the graph
 * reader of `graph-reads.ts` unchanged — so the graph-read grammar's reads and a
 * stage's own SQL (the history stage's three queries, through the `fact` view)
 * answer through the same seam. A read a caller makes on a transaction it already
 * opened runs on it (`executor`).
 */
export function createStageReadReader(options: StageReadsOptions): { query(text: string): Promise<readonly unknown[]> } {
  const delegated = createFactGraphReader(options);
  return {
    async query(text: string): Promise<readonly unknown[]> {
      const request = parseStageRead(text);
      if (request === null) return await delegated.query(text);
      const at = here();
      const answer = answerTo(request.read);
      if (answer === undefined) {
        raise(`${at}: the read ${readText(request)} names no read this module answers: it answers ${STAGE_READ_NAMES.join(', ')}`);
      }
      return await withLocation(at, `stageRead(${readText(request)})`, answer.tables, async () => await inTransaction(options, async (executor) => await answer.answer(executor, request, at)));
    },
  };
}

/** Runs one read's statements on the transaction the caller lent it, or in one of the owner's own snapshot transactions. */
async function inTransaction<R>(options: StageReadsOptions, work: (executor: SqlExecutor) => Promise<R>): Promise<R> {
  const lent = options.executor;
  if (lent !== undefined) return await work(lent);
  return await options.database.transaction('snapshot', async (executor) => await work(executor));
}
