/**
 * The data model of the code, as static stages (decision 0033, items 5, 14 and
 * 15; decision 0028's `code.*` records): the databases a repository's migrations
 * and Prisma schemas declare, their tables, columns and indexes, the foreign
 * keys and logical references between them, and the functions that read or write
 * them. Two stages publish the reading:
 *
 * - **`data-model`**, one unit per file, publishes the records whose span stands
 *   in that file: a migration's node and the tables, columns and indexes its
 *   statements declare; a Prisma schema's tables and the columns, indexes and
 *   keys only the model declares; a code file's table accesses and the tables
 *   its SQL literals create; a seed script's writes; and the storage evidence a
 *   file gives (a storage driver's import, a manifest's dependency, an
 *   environment file's connection setting, a compose service's, a code file's
 *   environment read). Each record is owned by the file its span stands in, and
 *   a unit publishes exactly the records it owns.
 * - **`data-model-aggregate`**, one unit per database, publishes the records one
 *   file cannot own: the database node with the evidence that declares it, what
 *   it holds and contains, and the service that uses it. It stands on the first
 *   stage's published records — per-file evidence, schema readings, migrations
 *   and tables — through bounded graph reads, and on nothing wider.
 *
 * **The rule that makes the port exact.** The extract driver (`src/extract/
 * data-model/extract.ts`) reads one repository-wide object and publishes the
 * merge of every file's statements. A static unit may not hold that object, so
 * the merge is reconstructed per unit from the files of its own database (the
 * migrations and the schema, read one at a time through the static context) with
 * the driver's own pure readers and merge functions (`parseSqlScript`,
 * `parsePrismaSchema`, `applyStatements`, `applyPrismaModel`, `scanScriptWrites`,
 * `extractFileAccess`, `indexGoPackage`, `resolveGoCalls`). The record each unit
 * writes is the one whose span stands in the unit's own file; the driver's merge
 * decides which records those are (a Prisma model's table block re-cites a table
 * a migration created, and a model-only column is the model's own).
 *
 * **What a unit reads of its group.** The migrations of a database and the Go
 * files of a package are groups a unit reads together: the static context lists
 * the files under a folder (`filesUnder`) and hands each file's bytes below the
 * cap, so a unit never holds a tree reader and never lists the repository. The
 * plan re-plans every unit of a group when any file of the group moved, so a
 * changed sibling re-reads the units that stood on it.
 *
 * **What a unit publishes when it cannot read.** A path the commit no longer
 * holds publishes nothing, and the publication retracts what an earlier run
 * wrote for it. A file above the static cap, bytes that are not UTF-8, a
 * migration the SQL parser refused and a model the Prisma reader could not read
 * are named in the file's coverage — a gap, never a silence.
 */
import { Type } from 'typebox';
import { canonicalJsonDigest } from '../../model/canonical.js';
import { byCodePoint } from '../../model/order.js';
import { manifestChainOf, serviceMembershipOf, folderOf, type ManifestEntry, type ManifestLookup } from './service-membership.js';
import { repositoryConventions } from '../../extract/library-models/repository-conventions.js';
import { environmentModels } from '../../extract/library-models/environment-models.js';
import {
  applyPrismaModel, applyStatements, databaseOf, declaresTablesOfText, migrationSeriesOf,
  modelPropertyOf, scanScriptWrites, tableOf, STORAGE_DRIVER_IMPORT,
  type MergedDatabase, type MergedTable, type MigrationPlace,
} from '../../extract/data-model/extract.js';
import { columnKey, databaseKey, indexKey, migrationKey, tableKey } from '../../extract/data-model/keys.js';
import type { MergedColumn } from '../../extract/data-model/extract.js';
import { extractFileAccess, type AccessSite, type FileAccess, type FunctionRegion } from '../../extract/data-model/access.js';
import { indexGoPackage, resolveGoCalls, type GoPackageFile } from '../../extract/data-model/go-calls.js';
import { parsePrismaSchema, type PrismaModel } from '../../extract/data-model/prisma.js';
import { parseSqlScript, type SqlStatement } from '../../extract/data-model/sql.js';
import type { SourceSpan } from '../../extract/records.js';
import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';
import { parseEnv } from 'node:util';
import { ByteText } from '../../extract/data-model/text-scan.js';
import { readGoMod } from './manifest-format.js';
import { extractFileSyntax } from './syntax-extract.js';
import { libraryEffectsOf } from './library-effects.js';
import { FACT_KINDS, isRepositoryPath, makeNodeFact, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS, type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite,
  type StageExecutionResult, type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { evidenceAtPlace, refuseRow, rowRecord, unknownKeys } from './draft.js';
import { STATIC_FILE_BYTE_LIMIT, type StaticStageContext, type StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The per-file stage's id. */
export const DATA_MODEL_STAGE_ID = 'data-model';

/** The aggregate stage's id: the records one file cannot own. */
export const DATA_MODEL_AGGREGATE_STAGE_ID = 'data-model-aggregate';

/** The node kinds the per-file stage writes: the reading's own, and the two per-file records the aggregate reads. */
export const DATA_MODEL_NODE_KINDS: readonly string[] = ['code.column', 'code.database', 'code.index', 'code.migration', 'code.table'];

/** The relations the per-file stage writes. */
export const DATA_MODEL_RELATIONS: readonly string[] = [
  'code.alters', 'code.contains', 'code.covers', 'code.creates', 'code.foreign-key', 'code.holds',
  'code.logical-reference', 'code.reads-table', 'code.uses-database', 'code.writes-table',
];

/** The fact kinds the per-file stage produces, as its draft is checked. */
const PER_FILE_KINDS: readonly string[] = [
  'alters', 'column', 'contains', 'covers', 'coverage', 'creates', 'foreign-key', 'holds', 'index',
  'migration', 'reads-table', 'schema-reading', 'storage-evidence', 'table', 'writes-table',
];

/** The fact kinds the aggregate stage produces. */
const AGGREGATE_KINDS: readonly string[] = ['contains', 'coverage', 'database', 'holds', 'logical-reference', 'uses-database'];

/** The readers every record of each stage cites. */
const DATA_MODEL_SOURCE: FactSource = { system: 'madarch-data-model', version: '1' };
const AGGREGATE_SOURCE: FactSource = { system: 'madarch-data-model-aggregate', version: '1' };

/** The read the per-file plan makes of what the stage published: one row per file it read. */
export const DATA_MODEL_PUBLISHED_READ = 'stage-data-model-published';

/** The read the aggregate plan makes of what that stage published: one row per database it read. */
export const DATA_MODEL_AGGREGATE_PUBLISHED_READ = 'stage-data-model-aggregate-published';

/** The read of one database's inputs: the four kinds the aggregate assembles, one page after another. */
export const DATA_MODEL_DATABASE_INPUTS_READ = 'stage-data-model-database-inputs';

/** One row of the per-file read. */
interface PublishedDataModelRow {
  readonly kind: 'coverage';
  readonly file: string;
  readonly blob: string;
  /** The databases the file contributed records to, as its coverage carries them. */
  readonly databases?: readonly { readonly folder: string; readonly name: string }[];
  /** The files the unit's reading stood on: its own, and the files its library effects chained through. */
  readonly reads?: readonly string[];
}

/** One row of the aggregate read. */
interface PublishedDatabaseRow {
  readonly kind: 'coverage';
  readonly database: string;
  readonly digest: string;
}

/** The keys a per-file row holds, and no others. */
const DATA_MODEL_ROW_FIELDS: readonly string[] = ['blob', 'databases', 'file', 'kind', 'read'];
/** The keys an aggregate row holds, and no others. */
const DATABASE_ROW_FIELDS: readonly string[] = ['database', 'digest', 'kind'];

/** One span a record stands at, as the driver counts it: bytes and 1-based lines. */
interface Span {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One write's place, as the graph holds a fact's provenance. */
interface Place {
  readonly file: string;
  readonly range: {
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
    readonly startByte: number;
    readonly endByte: number;
  };
}

/** One unit's draft, as the reading builds it: nodes and edges by the keys the graph names them. */
interface Sink {
  readonly repository: string;
  readonly commit: string;
  readonly source: FactSource;
  readonly path: string;
  readonly writes: StageDraftWrite[];
  /**
   * The files this unit's reading stood on: its own, and the files its library effects chained through
   * (decision 0033, item 15). The unit's coverage records them, so the plan names the unit again when one
   * of them moves — a fact read through another file is a fact this unit stands on.
   */
  readonly read: Set<string>;
  /** The node keys and edge identities this unit already wrote: one draft names one node and one edge once (the driver's own rule). */
  readonly seenNodes: Set<string>;
  readonly seenEdges: Set<string>;
}

/** A database's own name for a folder: the unit's name, or the folder's own name where no unit holds it. */
function folderName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/** The last leg of a path: the file's own name. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The place one span gives a fact: its path, its lines and its bytes, never a column the driver does not name. */
function placeOf(span: Span): Place {
  return { file: span.path, range: { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0, startByte: span.byteStart, endByte: span.byteEnd } };
}

/** The place of a whole file, as the driver's `wholeFile` counts it: every byte, and the lines `split('\n')` names. */
function wholeFilePlace(path: string, text: string, bytes: number): Place {
  return { file: path, range: { startLine: 1, startColumn: 0, endLine: text.split('\n').length, endColumn: 0, startByte: 0, endByte: bytes } };
}

/** One node write: the reading's properties, the graph's bookkeeping and the place it stands at. */
function writeNode(sink: Sink, kind: string, factKind: string, key: string, label: string, properties: Readonly<Record<string, unknown>>, place: Place | undefined): void {
  if (sink.seenNodes.has(key)) return;
  sink.seenNodes.add(key);
  sink.writes.push({
    kind: 'node',
    evidence: evidenceAtPlace({ repository: sink.repository, commit: sink.commit }, sink.path),
    value: {
      key,
      kind,
      label,
      properties: {
        ...properties,
        recordKey: key,
        factKind,
        layer: 'extracted',
        status: 'proposed',
        // The repository the record stands in, as every static stage's node carries it: a bounded
        // read by repository (`byProperty(kind, 'repository', …)`) is how a plan and a comparison
        // find this stage's records again (madarch-8bdc.2.4).
        repository: sink.repository,
        provenance: { source: sink.source, repository: { id: sink.repository, commit: sink.commit }, ...(place === undefined ? {} : { place }) },
      },
    },
  });
}

/** One edge write: its two ends by key, its discriminator, its properties and the repository it belongs to. */
function writeEdge(sink: Sink, relation: string, factKind: string, from: string, to: string, properties: Readonly<Record<string, unknown>>, discriminator = ''): void {
  // The driver publishes a structural relation once between two records, however many statements
  // say it (two `ALTER`s of one table are one `code.alters` edge): the draft keeps that rule.
  const identity = [relation, from, to, discriminator].join('\u0000');
  if (sink.seenEdges.has(identity)) return;
  sink.seenEdges.add(identity);
  sink.writes.push({
    kind: 'edge',
    evidence: evidenceAtPlace({ repository: sink.repository, commit: sink.commit }, sink.path),
    value: { relation, from: { key: from }, to: { key: to }, ...(discriminator === '' ? {} : { discriminator }), properties: { ...properties, factKind, repository: sink.repository } },
  });
}

/** The stage over the source that holds the run's pins. */
export function createDataModelStage(sources: SnapshotSource): FillStage {
  return {
    id: DATA_MODEL_STAGE_ID,
    version: 1,
    staticReading: true,
    // The file nodes stage 0 published are what a record hangs from and what the plan compares
    // blobs against; the code facts and symbols the access reading joins are the syntax and
    // code-facts stages' publications, and a graph without them is a stage that reads no access.
    consumes: {
      required: [{ capability: 'file', scope: 'repository', freshness: 'current' }],
      optional: [{ capability: 'symbol', scope: 'repository', freshness: 'current' }, { capability: 'callsite', scope: 'repository', freshness: 'current' }],
    },
    produces: [
      ...PER_FILE_KINDS.filter((kind) => kind !== 'coverage').map((kind) => ({ kind, schemaVersion: 1, scope: 'file' as const })),
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planDataModel(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeDataModelUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(DATA_MODEL_STAGE_ID, PER_FILE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/** The unit id of one file of this stage. */
function unitOfFile(repository: string, path: string): string {
  return fileUnitId(repository, path);
}

/** The scope one unit covers: the repository and the file, as every file-reading stage names it. */
function scopeOf(repository: string, path: string): string {
  return `${repository}:${path}`;
}

/** Whether a path is a file this stage reads: a migration or SQL script, a Prisma schema, a source file, or a file that gives storage evidence. */
function isDataModelPath(path: string): boolean {
  if (path.endsWith('.sql')) return true;
  if (prismaSchemaPlaceOf(path) !== undefined) return true;
  if (driverLanguageOf(path) !== null) return true;
  if (composeFile(path)) return true;
  const name = fileName(path);
  return name === 'go.mod' || name === 'package.json' || /^\.?env(?:\.[^/]*)?$/.test(name);
}

/** The language the extract driver reads a path's code as, and no other: the port reads the same files it read. */
function driverLanguageOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return ['.go', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'].includes(extension) ? extension.slice(1) : null;
}

/** The Prisma schema convention one path names, where it names one. */
function prismaSchemaPlaceOf(path: string): (typeof repositoryConventions.prismaSchemas)[number] | undefined {
  const segments = path.split('/');
  const file = segments[segments.length - 1] ?? '';
  return repositoryConventions.prismaSchemas.find((entry) => entry.fileName === file && segments[segments.length - 2] === entry.folder);
}

/** Whether a path is a compose file, by the driver's own rule. */
function composeFile(path: string): boolean {
  return /(?:^|\/)(?:docker-)?compose(?:\.[^/.]+)?\.ya?ml$/.test(path);
}

/** Whether a path is a migration of one of the registry's series. */
function migrationPlaceOf(path: string): MigrationPlace | undefined {
  const segments = path.split('/');
  return migrationSeriesOf(segments, segments[segments.length - 1] ?? '');
}

/** The folder a database is named after: the folder before the series or schema the path stands in. */
function databaseFolderOf(path: string): string | undefined {
  const segments = path.split('/');
  const place = migrationPlaceOf(path);
  if (place !== undefined) return segments.slice(0, place.at).join('/');
  const schema = prismaSchemaPlaceOf(path);
  if (schema !== undefined) return segments.slice(0, segments.length - 2).join('/');
  return undefined;
}

/** The folders of a repository that hold a manifest, nearest-first lookup's own roots. */
function manifestFoldersOf(paths: readonly string[]): readonly string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const name = fileName(path);
    if (name !== 'go.mod' && name !== 'package.json') continue;
    const folder = folderOf(path);
    if (foreignFolder(folder)) continue;
    folders.add(folder);
  }
  return [...folders].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Whether a folder stands under a name the conventions call another project's. */
function foreignFolder(folder: string): boolean {
  const legs = folder.split('/');
  return repositoryConventions.foreignManifestFolders.some((entry) => legs.includes(entry.folder));
}

/** The nearest manifest folder above a path: the unit root the path's reading stands in. */
function unitRootOf(path: string, manifestFolders: readonly string[]): string {
  let best = '';
  for (const folder of manifestFolders) {
    if (folder === '') continue;
    if (path !== folder && !path.startsWith(`${folder}/`)) continue;
    if (folder.length > best.length) best = folder;
  }
  return best;
}

/**
 * The groups one path's reading stands on, by what it reads: the database's merge
 * (the migrations and the schema that decide every table, column and index it
 * writes), the tables another unit declared (a seed's owner lookup, a code file's
 * resolution of a table), the Go package it rolls calls up through, and the
 * manifests that declare its unit. A file that contributes to a group dirties it
 * for every file that reads it, and no file re-reads because a sibling in its
 * folder moved for no reason of its own.
 */
function groupsOf(path: string, manifestFolders: readonly string[]): readonly string[] {
  const root = unitRootOf(path, manifestFolders);
  const groups: string[] = [];
  if (isMergeContributor(path) || driverLanguageOf(path) !== null || path.endsWith('.sql')) groups.push(`merge:${root}`);
  if (path.endsWith('.go')) groups.push(`package:${folderOf(path)}`);
  if (driverLanguageOf(path) !== null || path.endsWith('.sql')) groups.push('tables:*');
  return groups;
}

/** Whether a path contributes to a database's merge: a migration of a series, a schema script, or a Prisma schema. */
function isMergeContributor(path: string): boolean {
  return migrationPlaceOf(path) !== undefined || prismaSchemaPlaceOf(path) !== undefined;
}

/** What one dirty path dirties: the groups its own reading feeds. */
function dirtiedBy(path: string, manifestFolders: readonly string[]): readonly string[] {
  const root = unitRootOf(path, manifestFolders);
  const groups: string[] = [];
  // A manifest that moved declares the unit every file under it belongs to again.
  if (isManifest(path)) groups.push(`manifest:${path}`);
  if (isMergeContributor(path)) groups.push(`merge:${root}`);
  if (path.endsWith('.go')) groups.push(`package:${folderOf(path)}`);
  if (driverLanguageOf(path) !== null || path.endsWith('.sql') || isMergeContributor(path)) groups.push('tables:*');
  return groups;
}

/** Whether a path is one of the manifests a unit is declared by. */
function isManifest(path: string): boolean {
  const name = fileName(path);
  return name === 'go.mod' || name === 'package.json';
}

/** The class a unit's records must be published in: a schema's tables before a migration's keys, a migration's tables before a seed's writes. */
function unitClassOf(path: string): number {
  if (prismaSchemaPlaceOf(path) !== undefined) return 0;
  if (migrationPlaceOf(path) !== undefined) return 1;
  if (path.endsWith('.sql')) return 2;
  if (driverLanguageOf(path) !== null) return 3;
  return 4;
}

/** The order two files' units stand in the plan: the class, then the database's own migration order, then the path. */
function unitOrder(left: string, right: string): number {
  const byClass = unitClassOf(left) - unitClassOf(right);
  if (byClass !== 0) return byClass;
  const leftPlace = migrationPlaceOf(left);
  const rightPlace = migrationPlaceOf(right);
  if (leftPlace !== undefined && rightPlace !== undefined) {
    const leftDatabase = databaseFolderOf(left) ?? '';
    const rightDatabase = databaseFolderOf(right) ?? '';
    if (leftDatabase !== rightDatabase) return byCodePoint(leftDatabase, rightDatabase);
    // The driver's order: the plain SQL series first, then Prisma's, each by its name.
    const leftPrisma = leftPlace.series.nameFrom === 'parent' ? 1 : 0;
    const rightPrisma = rightPlace.series.nameFrom === 'parent' ? 1 : 0;
    if (leftPrisma !== rightPrisma) return leftPrisma - rightPrisma;
    return byCodePoint(leftPlace.name, rightPlace.name) || byCodePoint(left, right);
  }
  return byCodePoint(left, right);
}

/**
 * The units one run fills: a unit per file this stage reads, planned when the file
 * is new or its blob moved, when any file of its group (its unit, its database or
 * its Go package) is new or moved, or when the file's reading left no coverage —
 * and one per published file the commit no longer holds, which publishes nothing
 * and so retracts what an earlier run wrote for it. A file whose node the snapshot
 * has not published blocks the plan, as every static stage's plan does.
 */
async function planDataModel(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const ownRead = JSON.stringify({ read: DATA_MODEL_PUBLISHED_READ, repository: pin.id });
    const own = publishedDataModelRows(await graph.query(ownRead), pin.id, ownRead);
    const covered = new Map<string, string>(own.map((row) => [row.file, row.blob]));
    const paths = [...tree.files.keys()].sort(byCodePoint);
    const relevant = paths.filter(isDataModelPath);
    anySource = anySource || relevant.length > 0;
    const manifestFolders = manifestFoldersOf(paths);
    const present = new Set(paths);
    // The manifests above a folder, as groups: a manifest whose blob moved re-reads every file whose
    // unit it declares, although the files' own bytes did not move.
    const chains = new Map<string, readonly string[]>();
    const chainOf = async (folder: string): Promise<readonly string[]> => {
      const held = chains.get(folder);
      if (held !== undefined) return held;
      const lookup: ManifestLookup = async (candidate: string) => {
        const blob = tree.files.get(candidate);
        return blob === undefined ? undefined : { path: candidate, blob };
      };
      const chain = (await manifestChainOf(folder, lookup)).map((entry) => `manifest:${entry.slice(0, entry.lastIndexOf('@'))}`);
      chains.set(folder, chain);
      return chain;
    };
    // What moved, by group: a file that is new, whose blob moved, or that the commit no longer
    // holds makes every unit that reads its group again.
    const dirty = new Set<string>();
    // A unit stands on the files its own reading chained through, and a file among them whose bytes moved
    // (or that the commit no longer holds) moves what the unit says: it is planned again although its own
    // bytes did not move, which is the resolution stage's own rule (decision 0033, item 15).
    const readsOf = new Map<string, readonly string[]>(own.map((row) => [row.file, row.reads ?? []]));
    const readMoved = (path: string): boolean => (readsOf.get(path) ?? []).some((read) => {
      if (read === path) return false;
      return covered.get(read) !== tree.files.get(read);
    });
    for (const path of relevant) {
      if (covered.get(path) === tree.files.get(path)) continue;
      for (const group of dirtiedBy(path, manifestFolders)) dirty.add(group);
    }
    for (const row of own) {
      if (present.has(row.file)) continue;
      for (const group of dirtiedBy(row.file, manifestFolders)) dirty.add(group);
    }
    for (const path of relevant) {
      if (!tree.files.has(path)) {
        blocked = true;
        continue;
      }
      const groups = [...await chainOf(folderOf(path)), ...groupsOf(path, manifestFolders)];
      if (covered.get(path) === tree.files.get(path) && !readMoved(path) && !groups.some((group) => dirty.has(group))) continue;
      units.push({ id: unitOfFile(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    for (const row of own) {
      if (present.has(row.file)) continue;
      units.push({ id: unitOfFile(pin.id, row.file), scope: scopeOf(pin.id, row.file) });
    }
    void reader;
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => {
    const leftPath = left.scope.slice(left.scope.indexOf(':') + 1);
    const rightPath = right.scope.slice(right.scope.indexOf(':') + 1);
    return unitOrder(leftPath, rightPath) || byCodePoint(left.id, right.id);
  });
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** One row of the per-file read, read: the file and the blob its bytes stood under. */
function publishedDataModelRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedDataModelRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'the files this stage read');
    unknownKeys(held, DATA_MODEL_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || file === '') throw refuseRow(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a coverage stands for a file of the repository`);
    const blob = held['blob'];
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) throw refuseRow(read, index, repository, `its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    const databases = held['databases'];
    const reads = held['read'];
    if (reads !== undefined) {
      if (!Array.isArray(reads) || reads.some((one) => typeof one !== 'string' || !isRepositoryPath(one))) {
        throw refuseRow(read, index, repository, `its read ${JSON.stringify(reads)} is no list of repository paths: the files a unit's reading stood on are paths of this repository`);
      }
    }
    return { kind: 'coverage', file, blob, ...(databases === undefined ? {} : { databases: databases as readonly { readonly folder: string; readonly name: string }[] }), ...(reads === undefined ? {} : { reads: reads as readonly string[] }) };
  });
}

// ---- one unit ------------------------------------------------------------

/** One file's text, or the reason its bytes are no text this stage reads. */
async function readTextOf(stage: StaticStageContext, path: string): Promise<{ readonly ok: true; readonly text: string; readonly bytes: number } | { readonly ok: false; readonly reason: string }> {
  const file = await stage.repository.file(path);
  if (file === undefined) return { ok: false, reason: 'inaccessible' };
  if (file.unread === 'too-large') return { ok: false, reason: 'too-large' };
  if (file.unread !== undefined || file.content === undefined) return { ok: false, reason: 'unsupported' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(file.content), bytes: file.content.byteLength };
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
}

/** One database's files, as the units that read it see them: its migrations in the driver's order and its schema. */
interface DatabaseGroup {
  readonly root: string;
  readonly name: string;
  readonly migrations: readonly { readonly path: string; readonly name: string; readonly prisma: boolean }[];
  readonly schemaPath?: string;
}

/** How one unit reads a manifest above its file: one path at a time, its blob and, below the cap, its bytes. */
function manifestLookup(source: StaticStageSource): ManifestLookup {
  return async (path: string): Promise<ManifestEntry | undefined> => {
    const entry = await source.entry(path);
    if (entry === undefined || entry.form === 'commit') return undefined;
    if (entry.bytes !== undefined && entry.bytes > STATIC_FILE_BYTE_LIMIT) return { path, blob: entry.id };
    const file = await source.file(path);
    return { path, blob: entry.id, ...(file?.content === undefined ? {} : { bytes: file.content }) };
  };
}

/** The unit a file belongs to, read one manifest at a time. */
async function membershipOf(stage: StaticStageContext, path: string): Promise<{ readonly name: string; readonly root: string } | undefined> {
  const read = await serviceMembershipOf(path, manifestLookup(stage.repository));
  const unit = read.unit;
  return unit === undefined ? undefined : { name: unit.name, root: unit.root };
}

/**
 * The database one migration or schema belongs to: its root, its name, its
 * migrations in the driver's order and its Prisma schema. The root is the unit
 * the file's folder belongs to, or the folder before the series where no unit
 * holds it; the migrations are the files under the root's `migrations` and
 * `prisma/migrations` folders, the plain series first, each by name.
 */
async function databaseGroupOf(stage: StaticStageContext, path: string): Promise<DatabaseGroup> {
  const membership = await membershipOf(stage, path);
  const place = migrationPlaceOf(path);
  const schema = prismaSchemaPlaceOf(path);
  const segments = path.split('/');
  const fallback = place !== undefined ? segments.slice(0, place.at).join('/') : schema !== undefined ? segments.slice(0, segments.length - 2).join('/') : folderOf(path);
  const root = membership?.root ?? fallback;
  const name = membership?.name ?? folderName(root);
  // A database's files are the unit's own, wherever inside it they stand: the driver reads every path of the
  // tree and files a migration under the unit that covers it (`databaseOfPath`, src/extract/data-model/extract.ts),
  // so a series in `db/migrations` belongs to the unit that holds the folder and not only to `<root>/migrations`.
  // The listing is the unit's subtree, a path-scoped answer of the static context, and every candidate is filed
  // by the same rule the driver applies: the unit covering its path, else the folder before the series.
  const migrations: { path: string; name: string; prisma: boolean }[] = [];
  let schemaPath: string | undefined;
  for (const entry of await stage.repository.filesUnder(root)) {
    if (entry.form === 'commit') continue;
    const series = migrationPlaceOf(entry.path);
    const schemaOf = prismaSchemaPlaceOf(entry.path);
    const candidate = series !== undefined || schemaOf !== undefined;
    if (!candidate) continue;
    const owner = await membershipOf(stage, entry.path);
    const database = series !== undefined
      ? owner?.name ?? folderName(entry.path.split('/').slice(0, series.at).join('/'))
      : owner?.name ?? folderName(entry.path.split('/').slice(0, entry.path.split('/').length - 2).join('/'));
    if (database !== name) continue;
    if (series !== undefined) {
      migrations.push({ path: entry.path, name: series.name, prisma: series.series.nameFrom === 'parent' });
      continue;
    }
    schemaPath = entry.path;
  }
  migrations.sort((left, right) => (left.prisma === right.prisma ? 0 : left.prisma ? 1 : -1) || byCodePoint(left.name, right.name) || byCodePoint(left.path, right.path));
  return { root, name, migrations, ...(schemaPath === undefined ? {} : { schemaPath }) };
}

/** One database's merge, rebuilt from its own files: what the driver holds after every migration and the schema. */
interface Merged {
  readonly database: MergedDatabase;
  readonly modelTables: ReadonlyMap<string, string>;
  readonly fieldSpans: ReadonlyMap<string, Span>;
  readonly models: readonly PrismaModel[];
}

/** The span one SQL statement cites, as the driver's schema readings count it. */
function statementSpan(statement: SqlStatement): Span | undefined {
  if (statement.kind === 'other') return undefined;
  if (statement.kind === 'create-table') return statement.table.span;
  if (statement.kind === 'alter-table-add-column') return statement.column.span;
  if (statement.kind === 'create-index') return statement.index.span;
  return statement.span;
}

/**
 * Rebuilds one database's merge from the files of its group: the migrations in
 * their order and the Prisma schema, applied with the driver's own merge
 * functions. A file that cannot be read is named in `gaps`, and the merge goes
 * on without it — the driver's own behaviour, never a silent skip.
 */
async function mergedDatabaseOf(stage: StaticStageContext, group: DatabaseGroup, gaps: CoverageGap[]): Promise<Merged> {
  const databases = new Map<string, MergedDatabase>();
  const database = databaseOf(databases, group.name);
  for (const migration of group.migrations) {
    const read = await readTextOf(stage, migration.path);
    if (!read.ok) {
      gaps.push({ what: `${migration.path}: the database's migration could not be read (${read.reason})`, reason: read.reason as CoverageGap['reason'] });
      continue;
    }
    applyStatements(database, parseSqlScript(migration.path, read.text).statements, []);
  }
  const modelTables = new Map<string, string>();
  const fieldSpans = new Map<string, Span>();
  const models: PrismaModel[] = [];
  if (group.schemaPath !== undefined) {
    const read = await readTextOf(stage, group.schemaPath);
    if (!read.ok) {
      gaps.push({ what: `${group.schemaPath}: the Prisma schema could not be read (${read.reason})`, reason: read.reason as CoverageGap['reason'] });
    } else {
      const parsed = parsePrismaSchema(group.schemaPath, read.text);
      if (parsed.length === 0) gaps.push({ what: `${group.schemaPath}: no model could be read from the Prisma schema`, reason: 'unsupported' });
      const modelColumns = new Map<string, Map<string, string>>();
      for (const model of parsed) {
        models.push(model);
        modelTables.set(model.model, model.table);
        modelTables.set(modelPropertyOf(model.model), model.table);
        const columns = new Map<string, string>();
        for (const field of model.fields) columns.set(field.field, field.column);
        modelColumns.set(model.model, columns);
      }
      for (const model of parsed) {
        const table = tableOf(database, model.table);
        table.span = model.span;
        applyPrismaModel(table, model, modelTables, modelColumns, fieldSpans);
      }
    }
  }
  return { database, modelTables, fieldSpans, models };
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the data-model stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/data-model.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/data-model.ts)`);
  }
}

/** What one unit's reading found: the databases it contributed records to, as the aggregate stage plans them. */
interface Contribution {
  readonly folder: string;
  readonly name: string;
}

/**
 * One unit: the file the unit names, read at the pinned commit, and the records
 * its bytes own. A path the commit no longer holds publishes nothing, so an
 * earlier run's records for a file deleted or renamed away are retracted.
 */
async function executeDataModelUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  const source = stage.repository;
  refuseWhenCancelled(unit, context);
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const read = await readTextOf(stage, planned.path);
  const gaps: CoverageGap[] = [];
  const sink: Sink = { repository: planned.repository, commit: source.commit, source: DATA_MODEL_SOURCE, path: planned.path, writes: [], read: new Set([planned.path]), seenNodes: new Set(), seenEdges: new Set() };
  const contributions: Contribution[] = [];
  if (!read.ok) {
    gaps.push({ what: `${planned.path}: the file could not be read (${read.reason})`, reason: read.reason as CoverageGap['reason'] });
  } else {
    refuseWhenCancelled(unit, context);
    await readFileRecords(sink, stage, planned.path, read.text, read.bytes, gaps, contributions);
  }
  for (const write of sink.writes) context.draft.write(write);
  const coverage: CoverageValue = {
    repository: planned.repository,
    scope: planned.path,
    complete: gaps.length === 0,
    read: read.ok ? [planned.path] : [],
    unread: orderedGaps(gaps),
  };
  writeCoverage(context, source, planned.path, coverage, entry.id, contributions, [...sink.read]);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(sink.writes.length)} ${sink.writes.length === 1 ? 'record' : 'records'}, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** One file's records, by what the file is: a Prisma schema, a SQL script, a code file, or a file that only gives storage evidence. */
async function readFileRecords(sink: Sink, stage: StaticStageContext, path: string, text: string, bytes: number, gaps: CoverageGap[], contributions: Contribution[]): Promise<void> {
  await evidenceRecords(sink, stage, path, text, bytes, gaps, contributions);
  if (prismaSchemaPlaceOf(path) !== undefined) {
    await schemaRecords(sink, stage, path, text, gaps, contributions);
    return;
  }
  if (path.endsWith('.sql')) {
    await sqlRecords(sink, stage, path, text, bytes, gaps, contributions);
    return;
  }
  if (driverLanguageOf(path) !== null) {
    await codeRecords(sink, stage, path, text, bytes, gaps, contributions);
  }
}

/**
 * A coverage's gaps as the fact's own check reads them: code point order of what each names, and
 * each `what` once. The stage collects a gap where it meets one, so two records can name the same
 * place; the fact holds one record per place.
 */
function orderedGaps(gaps: readonly CoverageGap[]): readonly CoverageGap[] {
  return [...new Map(gaps.map((gap) => [gap.what, gap])).values()].sort((left, right) => byCodePoint(left.what, right.what));
}

/** One file's coverage: what was read, every place it could not read, the blob its bytes stood under and the databases it contributed to. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string, contributions: readonly Contribution[], read: readonly string[] = [path]): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: DATA_MODEL_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: { ...coverage, read: [...new Set(read)].sort(byCodePoint) },
  });
  for (const write of graphWritesOf(fact, evidenceAtPlace({ repository: coverage.repository, commit: source.commit }, path))) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob, databases: contributions.map((entry) => ({ folder: entry.folder, name: entry.name })) } } }
      : write);
  }
}

// ---- the records a file owns --------------------------------------------

/** The key of the file's own node, read from the graph the snapshot stage published. */
async function fileNodeKey(stage: StaticStageContext, repository: string, path: string): Promise<string | undefined> {
  const page = await stage.byProperty('code.file', 'path', path, { limit: 16 });
  const found = page.rows.filter((node) => node.properties['repository'] === repository && node.properties['path'] === path);
  if (found.length > 1) {
    throw new Error(`the graph holds ${String(found.length)} file nodes for ${JSON.stringify(path)} of ${JSON.stringify(repository)}, and one file is one node: the snapshot stage publishes it (src/fill/stages/data-model.ts)`);
  }
  return found[0]?.properties['recordKey'] === undefined ? undefined : String(found[0].properties['recordKey']);
}

/** The file's node key, refused by name where the graph holds none: a record hangs from the file it stands in. */
async function requireFileNode(stage: StaticStageContext, repository: string, path: string): Promise<string> {
  const key = await fileNodeKey(stage, repository, path);
  if (key === undefined) {
    throw new Error(`the graph holds no file node for ${JSON.stringify(path)} of ${JSON.stringify(repository)}: the data-model stage hangs its records from the file the snapshot stage publishes, and a run that reaches this unit without one is a run whose snapshot has not published it (src/fill/stages/data-model.ts)`);
  }
  return key;
}

/** One table node and the file's containment of it. */
function writeTable(sink: Sink, fileKey: string, database: string, folder: string, table: MergedTable, place: Place): void {
  const key = tableKey(database, table.name, table.schema);
  writeNode(sink, 'code.table', 'table', key, table.name, { schema: table.schema, database, databaseFolder: folder, name: table.name }, place);
  writeEdge(sink, 'code.contains', 'contains', fileKey, key, {});
}

/** One column node, the table's containment of it and the file's. */
function writeColumn(sink: Sink, fileKey: string, database: string, folder: string, table: MergedTable, column: MergedColumn): void {
  const key = columnKey(database, table.name, column.name, table.schema);
  writeNode(sink, 'code.column', 'column', key, column.name, {
    type: column.type,
    nullable: column.nullable,
    ...(column.default === undefined ? {} : { default: column.default }),
    ...(column.primaryKey ? { primaryKey: true } : {}),
    ...(column.unique ? { unique: true } : {}),
    ...(column.check === undefined ? {} : { check: column.check }),
    table: table.name,
    database,
    databaseFolder: folder,
    name: column.name,
    // Whether the column is one end of a foreign key: the aggregate stage's logical-reference
    // rule skips it, as the driver's own loop does (madarch-8bdc.2.4).
    ...(table.foreignKeys.some((foreignKey) => foreignKey.column === column.name) ? { foreignKey: true } : {}),
  }, column.span === undefined ? wholeFilePlaceOf(sink) : placeOf(column.span));
  writeEdge(sink, 'code.contains', 'contains', tableKey(database, table.name, table.schema), key, {});
  writeEdge(sink, 'code.contains', 'contains', fileKey, key, {});
}

/** One index node, its table's containment, the file's, and what it covers. */
function writeIndex(sink: Sink, fileKey: string, database: string, table: MergedTable, index: { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean; readonly where?: string; readonly span?: Span }): void {
  const key = indexKey(database, table.name, index.name, table.schema);
  writeNode(sink, 'code.index', 'index', key, index.name, {
    columns: [...index.columns].sort(byCodePoint),
    unique: index.unique,
    ...(index.where === undefined ? {} : { where: index.where }),
    table: table.name,
    database,
    name: index.name,
  }, index.span === undefined ? wholeFilePlaceOf(sink) : placeOf(index.span));
  writeEdge(sink, 'code.contains', 'contains', tableKey(database, table.name, table.schema), key, {});
  writeEdge(sink, 'code.contains', 'contains', fileKey, key, {});
  for (const column of [...index.columns].sort(byCodePoint)) {
    writeEdge(sink, 'code.covers', 'covers', key, columnKey(database, table.name, column, table.schema), {});
  }
}

/** The place of the unit's own file, for a record whose span the driver left at the table's: a whole file. */
function wholeFilePlaceOf(sink: Sink): Place {
  return { file: sink.path, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0, startByte: 0, endByte: 0 } };
}

/** One foreign key edge, or the gap that says why its target is not in the database. */
function writeForeignKey(sink: Sink, database: string, table: MergedTable, foreignKey: MergedTable['foreignKeys'][number], merged: Merged, gaps: CoverageGap[]): void {
  const target = merged.database.tables.get(foreignKey.targetTable);
  if (target === undefined) {
    gaps.push({ what: `${sink.path}: the foreign key of ${table.name}.${foreignKey.column} targets ${foreignKey.targetTable}, which no migration of ${database} declares`, reason: 'unsupported' });
    return;
  }
  const targetColumn = foreignKey.targetColumn ?? (target.primaryKey.length === 1 ? target.primaryKey[0] : undefined);
  writeEdge(sink, 'code.foreign-key', 'foreign-key', tableKey(database, table.name, table.schema), tableKey(database, target.name, target.schema), {
    column: foreignKey.column,
    ...(targetColumn === undefined ? {} : { targetColumn }),
    ...(foreignKey.constraint === undefined ? {} : { constraint: foreignKey.constraint }),
    ...(foreignKey.onDelete === undefined ? {} : { onDelete: foreignKey.onDelete }),
    ...(foreignKey.onUpdate === undefined ? {} : { onUpdate: foreignKey.onUpdate }),
    cardinality: 'many-to-one',
  }, foreignKey.constraint ?? foreignKey.column);
}

/** One page after another of a read by property, as the static context answers it. */
async function allByProperty(stage: StaticStageContext, kind: string, field: string, value: string): Promise<readonly { readonly id: string; readonly kind: string; readonly properties: Readonly<Record<string, unknown>> }[]> {
  const rows: { id: string; kind: string; properties: Readonly<Record<string, unknown>> }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty(kind, field, value, { limit: 256, ...(after === undefined ? {} : { after }) });
    for (const row of page.rows) rows.push({ id: row.id, kind: row.kind, properties: row.properties });
    if (page.next === null) return rows;
    after = page.next;
  }
}

// ---- migrations and SQL scripts -----------------------------------------

/** One SQL file's records: a migration's own, or a seed script's writes. */
async function sqlRecords(sink: Sink, stage: StaticStageContext, path: string, text: string, bytes: number, gaps: CoverageGap[], contributions: Contribution[]): Promise<void> {
  const group = await databaseGroupOf(stage, path);
  const place = migrationPlaceOf(path);
  const declares = place !== undefined ? { kind: 'schema' as const } : await declaresTablesOfText(path, text);
  if (declares.kind === 'script') {
    await seedRecords(sink, stage, path, text, gaps);
    return;
  }
  contributions.push({ folder: group.root, name: group.name });
  const merged = await mergedDatabaseOf(stage, group, gaps);
  const fileKey = await requireFileNode(stage, sink.repository, path);
  const name = place?.name ?? fileName(path);
  const prisma = place?.series.nameFrom === 'parent';
  const at = group.migrations.findIndex((migration) => migration.path === path);
  const ordinal = at < 0 ? 0 : at + 1;
  const migration = migrationKey(group.name, name);
  writeNode(sink, 'code.migration', 'migration', migration, name, { path, ordinal, database: group.name, databaseFolder: group.root, prisma }, wholeFilePlace(path, text, bytes));
  writeEdge(sink, 'code.contains', 'contains', fileKey, migration, {});
  const script = parseSqlScript(path, text);
  if (!script.statements.some((statement) => statement.kind !== 'other')) {
    const first = script.statements.find((statement) => statement.kind === 'other');
    const line = first === undefined ? 1 : first.span.lineStart;
    const detail = first === undefined ? 'the file holds no statement' : 'the statement is no CREATE, ALTER or INDEX this reader knows';
    gaps.push({ what: `${path}:${line}: no table or column declaration could be read: ${detail}`, reason: 'unsupported' });
  }
  // The statements' own edges: what this migration creates, alters and indexes.
  for (const statement of script.statements) {
    if (statement.kind === 'create-table') {
      const table = tableKey(group.name, statement.table.name, statement.table.schema);
      writeEdge(sink, 'code.creates', 'creates', migration, table, {});
      for (const column of statement.table.columns) writeEdge(sink, 'code.creates', 'creates', migration, columnKey(group.name, statement.table.name, column.name, statement.table.schema), {});
    } else if (statement.kind === 'alter-table-add-column') {
      writeEdge(sink, 'code.alters', 'alters', migration, tableKey(group.name, statement.table, statement.schema), { object: 'table' });
      writeEdge(sink, 'code.alters', 'alters', migration, columnKey(group.name, statement.table, statement.column.name, statement.schema), { object: 'column' });
    } else if (statement.kind === 'alter-table-add-foreign-key') {
      writeEdge(sink, 'code.alters', 'alters', migration, tableKey(group.name, statement.table, statement.schema), { object: 'table' });
      writeEdge(sink, 'code.alters', 'alters', migration, columnKey(group.name, statement.table, statement.foreignKey.column, statement.schema), { object: 'column' });
    } else if (statement.kind === 'create-index') {
      writeEdge(sink, 'code.creates', 'creates', migration, indexKey(group.name, statement.table, statement.index.name, statement.schema), {});
    }
  }
  // The statement spans the database's use edge cites, in the driver's own reading order.
  let sequence = 0;
  for (const statement of script.statements) {
    const span = statementSpan(statement);
    if (span === undefined) continue;
    writeSchemaReading(sink, group, { kind: 'migration', ordinal, sequence: sequence++, span });
  }
  // What the merge says this file owns: the first declaration's span is the record's place.
  for (const table of merged.database.tables.values()) {
    const tableSpan = table.span;
    if (tableSpan?.path === path) {
      writeTable(sink, fileKey, group.name, group.root, table, placeOf(tableSpan));
      for (const foreignKey of table.foreignKeys) writeForeignKey(sink, group.name, table, foreignKey, merged, gaps);
    }
    for (const column of table.columns.values()) {
      if (column.span?.path !== path) continue;
      writeColumn(sink, fileKey, group.name, group.root, table, column);
    }
    for (const index of table.indexes.values()) {
      if (index.span?.path !== path) continue;
      writeIndex(sink, fileKey, group.name, table, index);
    }
  }
}

/** One schema reading: a place the database's use edge cites, in the driver's order. */
function writeSchemaReading(sink: Sink, group: { readonly root: string; readonly name: string }, reading: { readonly kind: 'migration' | 'prisma' | 'declaration'; readonly ordinal: number; readonly sequence: number; readonly span: Span }): void {
  const key = `code.schema-reading:${sink.repository}:${sink.path}#${String(reading.sequence)}`;
  writeNode(sink, 'code.schema-reading', 'schema-reading', key, `${reading.kind} ${String(reading.ordinal)}`, {
    database: group.name,
    databaseFolder: group.root,
    kind: reading.kind,
    ordinal: reading.ordinal,
    sequence: reading.sequence,
    span: { path: reading.span.path, byteStart: reading.span.byteStart, byteEnd: reading.span.byteEnd, lineStart: reading.span.lineStart, lineEnd: reading.span.lineEnd },
  }, placeOf(reading.span));
}

// ---- Prisma schemas ------------------------------------------------------

/** One Prisma schema's records: the tables its models re-cite, the columns and indexes only it declares, the keys and the logical references. */
async function schemaRecords(sink: Sink, stage: StaticStageContext, path: string, text: string, gaps: CoverageGap[], contributions: Contribution[]): Promise<void> {
  const group = await databaseGroupOf(stage, path);
  contributions.push({ folder: group.root, name: group.name });
  const merged = await mergedDatabaseOf(stage, group, gaps);
  const fileKey = await requireFileNode(stage, sink.repository, path);
  const models = merged.models;
  if (models.length === 0) {
    gaps.push({ what: `${path}: no model could be read from the Prisma schema`, reason: 'unsupported' });
    return;
  }
  let sequence = 0;
  for (const model of models) {
    const table = merged.database.tables.get(model.table);
    if (table === undefined) continue;
    const tableSpan = table.span;
    if (tableSpan?.path === path) {
      writeTable(sink, fileKey, group.name, group.root, table, placeOf(model.span));
      for (const foreignKey of table.foreignKeys) writeForeignKey(sink, group.name, table, foreignKey, merged, gaps);
      writeSchemaReading(sink, group, { kind: 'prisma', ordinal: 0, sequence: sequence++, span: model.span });
    }
    for (const column of table.columns.values()) {
      if (column.span?.path !== path) continue;
      writeColumn(sink, fileKey, group.name, group.root, table, column);
    }
    for (const index of table.indexes.values()) {
      if (index.span?.path !== path) continue;
      writeIndex(sink, fileKey, group.name, table, index);
    }
  }
  void text;
}

// ---- code files ----------------------------------------------------------

/** The Prisma models of one unit, read from the schema beside its root where one stands: what a Prisma client call names. */
async function prismaModelsOf(stage: StaticStageContext, root: string): Promise<{ readonly tables: ReadonlyMap<string, string>; readonly columns: ReadonlyMap<string, ReadonlyMap<string, string>> }> {
  const tables = new Map<string, string>();
  const columns = new Map<string, Map<string, string>>();
  for (const place of repositoryConventions.prismaSchemas) {
    const candidate = [root, place.folder, place.fileName].filter((part) => part !== '').join('/');
    const entry = await stage.repository.entry(candidate);
    if (entry === undefined) continue;
    const read = await readTextOf(stage, candidate);
    if (!read.ok) continue;
    for (const model of parsePrismaSchema(candidate, read.text)) {
      tables.set(model.model, model.table);
      tables.set(modelPropertyOf(model.model), model.table);
      const held = new Map<string, string>();
      for (const field of model.fields) held.set(field.field, field.column);
      columns.set(model.model, held);
    }
  }
  return { tables, columns };
}

/** One table access resolved to the key of the table it names. */
interface ResolvedSite {
  readonly verb: 'read' | 'write';
  readonly to: string;
  readonly via: string;
}

/** One code file's records: the tables its SQL literals declare, and the tables its functions read and write. */
async function codeRecords(sink: Sink, stage: StaticStageContext, path: string, text: string, bytes: number, gaps: CoverageGap[], contributions: Contribution[]): Promise<void> {
  const membership = await membershipOf(stage, path);
  if (membership === undefined) return;
  const service = membership.name;
  const fileKey = await requireFileNode(stage, sink.repository, path);
  const access = await extractFileAccess(path, new Uint8Array(Buffer.from(text, 'utf8')));
  for (const gap of access.unread) gaps.push({ what: `${path}: code could not be read: ${gap.reason}`, reason: 'error' });
  const models = await prismaModelsOf(stage, membership.root);
  let contributed = false;
  // The tables this file's own SQL literals declare: they stand in this unit's draft, so a site
  // below resolves to them without reading the graph, which does not hold them yet. A table the
  // database's own migrations declare keeps their span and their unit, exactly as the driver's
  // merge does, so this file publishes it only where the merge does not.
  const group = await databaseGroupOf(stage, path);
  // The merge is this file's own question, not a second reading of the database: its gaps belong to
  // the migration's unit, which reads those bytes for its own records.
  const merged = await mergedDatabaseOf(stage, group, []);
  const declared = new Set<string>();
  let declarations = 0;
  for (const declaration of access.tableDeclarations) {
    const key = tableKey(service, declaration.table);
    declared.add(key);
    if (merged.database.tables.get(declaration.table)?.span !== undefined) continue;
    writeNode(sink, 'code.table', 'table', key, declaration.table, { schema: 'public', database: service, databaseFolder: membership.root, name: declaration.table }, placeOf(declaration.span));
    writeEdge(sink, 'code.contains', 'contains', fileKey, key, {});
    // The declaration is one of the database's storage readings: the driver cites it in the
    // `uses-database` origins after every migration and schema reading (madarch-8bdc.2.4).
    writeSchemaReading(sink, { root: membership.root, name: service }, { kind: 'declaration', ordinal: 0, sequence: declarations++, span: declaration.span });
    contributed = true;
  }
  if (contributed) contributions.push({ folder: membership.root, name: service });
  const symbols = (await allByProperty(stage, 'code.symbol', 'file', path))
    .filter((node) => node.properties['repository'] === sink.repository && isCallable(node.properties))
    .map((node) => ({ key: String(node.properties['recordKey']), properties: node.properties }));
  const fileOf = (): string => fileKey;
  const resolveSite = async (site: AccessSite): Promise<string | undefined> => {
    if (site.via === 'prisma-client') {
      const table = models.tables.get(site.table);
      if (table === undefined) {
        gaps.push({ what: `${path}: the Prisma model ${site.table} is not declared by the service's schema`, reason: 'unsupported' });
        return undefined;
      }
      return tableKey(service, table);
    }
    const key = tableKey(service, site.table);
    const held = declared.has(key) ? [] : await stage.byKey(key, { limit: 2 });
    if (held.length === 0 && !declared.has(key)) {
      gaps.push({ what: `${path}: line ${String(site.span.lineStart)}: table ${site.table} is not declared by service ${service}'s database; no connection evidence resolves it to a sibling database (${path})`, reason: 'unsupported' });
      return undefined;
    }
    return key;
  };
  const ownerOf = (span: { readonly byteStart: number; readonly byteEnd: number }): { readonly key: string; readonly qualifiedName: string } | undefined => {
    const held = symbols.filter((symbol) => {
      const place = symbolPlaceOf(symbol.properties);
      return place !== undefined && place.byteStart <= span.byteStart && span.byteEnd <= place.byteEnd;
    }).sort((left, right) => {
      const leftPlace = symbolPlaceOf(left.properties)!;
      const rightPlace = symbolPlaceOf(right.properties)!;
      return (leftPlace.byteEnd - leftPlace.byteStart) - (rightPlace.byteEnd - rightPlace.byteStart) || byCodePoint(left.key, right.key);
    });
    const found = held[0];
    if (found === undefined) return undefined;
    return { key: found.key, qualifiedName: String(found.properties['qualifiedName'] ?? '') };
  };
  const sites = new Map<string, { readonly type: string; readonly from: string; readonly to: string; readonly via: string; readonly callee?: string; sites: { path: string; byteStart: number; byteEnd: number; lineStart: number; lineEnd: number }[] }>();
  const direct: { readonly from: string; readonly to: string; readonly verb: 'read' | 'write'; readonly via: string; readonly span: AccessSite['span']; readonly region: string }[] = [];
  for (const site of access.sites) {
    const to = await resolveSite(site);
    if (to === undefined) continue;
    const owner = ownerOf(site.span);
    if (owner === undefined && site.region !== '') {
      gaps.push({ what: `${path}: line ${String(site.span.lineStart)}: table access has no canonical positioned function owner (${path})`, reason: 'unsupported' });
      continue;
    }
    const from = owner?.key ?? fileOf();
    direct.push({ from, to, verb: site.verb, via: site.via, span: site.span, region: site.region });
    const type = site.verb === 'read' ? 'code.reads-table' : 'code.writes-table';
    const key = `${type} ${from} ${to}`;
    const held = sites.get(key);
    if (held !== undefined) {
      if (!held.sites.some((candidate) => candidate.byteStart === site.span.byteStart)) held.sites.push({ path: site.span.path, byteStart: site.span.byteStart, byteEnd: site.span.byteEnd, lineStart: site.span.lineStart, lineEnd: site.span.lineEnd });
      continue;
    }
    sites.set(key, { type, from, to, via: site.via, sites: [{ path: site.span.path, byteStart: site.span.byteStart, byteEnd: site.span.byteEnd, lineStart: site.span.lineStart, lineEnd: site.span.lineEnd }] });
  }
  for (const held of sites.values()) {
    writeEdge(sink, held.type, held.type === 'code.reads-table' ? 'reads-table' : 'writes-table', held.from, held.to, {
      via: held.via,
      sites: [...held.sites].sort((left, right) => left.byteStart - right.byteStart),
    });
  }
  if (access.language === 'go') {
    await goRollUp(sink, stage, path, text, access, direct, symbols, resolveSite, gaps);
  }
  void bytes;
}

/** Whether a symbol node is a function, method or constructor: the driver's own canonical callables. */
function isCallable(properties: Readonly<Record<string, unknown>>): boolean {
  return ['function', 'method', 'constructor'].includes(String(properties['symbolKind'] ?? ''));
}

/** The byte span a symbol node's place carries. */
function symbolPlaceOf(properties: Readonly<Record<string, unknown>>): { readonly byteStart: number; readonly byteEnd: number } | undefined {
  const provenance = properties['provenance'];
  const place = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['place'] : undefined;
  const range = place !== null && typeof place === 'object' ? (place as Record<string, unknown>)['range'] : undefined;
  if (range === null || typeof range !== 'object') return undefined;
  const held = range as Record<string, unknown>;
  return typeof held['startByte'] === 'number' && typeof held['endByte'] === 'number' ? { byteStart: held['startByte'], byteEnd: held['endByte'] } : undefined;
}

/** The symbol node a region's qualified name names, by the global name the syntax stage gave it. */
async function symbolKeyOf(stage: StaticStageContext, repository: string, path: string, qualifiedName: string): Promise<string | undefined> {
  const held = await stage.byGlobalName(`${repository}:${path}#${qualifiedName}`, { limit: 8 });
  const found = held.find((node) => node.kind === 'code.symbol' && node.properties['file'] === path && node.properties['qualifiedName'] === qualifiedName);
  return found === undefined ? undefined : String(found.properties['recordKey']);
}

/**
 * The Go call roll-up of one file: what a function reaches through the
 * functions of its own package. The package's files are read through the
 * static context — the reader `resolveGoCalls` needs their text — and the
 * driver's own `indexGoPackage` and `resolveGoCalls` decide every call, so the
 * fill and the driver resolve the same calls to the same callees.
 */
async function goRollUp(
  sink: Sink,
  stage: StaticStageContext,
  path: string,
  text: string,
  access: FileAccess,
  direct: readonly { readonly from: string; readonly to: string; readonly verb: 'read' | 'write'; readonly via: string; readonly span: AccessSite['span']; readonly region: string }[],
  symbols: readonly { readonly key: string; readonly properties: Readonly<Record<string, unknown>> }[],
  resolveSite: (site: AccessSite) => Promise<string | undefined>,
  gaps: CoverageGap[],
): Promise<void> {
  const folder = folderOf(path);
  const siblings = (await stage.repository.filesUnder(folder)).filter((entry) => folderOf(entry.path) === folder && entry.path.endsWith('.go') && entry.form !== 'commit');
  if (siblings.length > 64) {
    gaps.push({ what: `${path}: the Go package holds ${String(siblings.length)} files where the roll-up reads at most 64`, reason: 'budget' });
    return;
  }
  const packageFiles: { readonly path: string; readonly text: string; readonly access: FileAccess }[] = [];
  for (const sibling of siblings) {
    if (sibling.path === path) {
      packageFiles.push({ path, text, access });
      continue;
    }
    const read = await readTextOf(stage, sibling.path);
    if (!read.ok) {
      gaps.push({ what: `${sibling.path}: the package's file could not be read (${read.reason})`, reason: read.reason as CoverageGap['reason'] });
      continue;
    }
    packageFiles.push({ path: sibling.path, text: read.text, access: await extractFileAccess(sibling.path, new Uint8Array(Buffer.from(read.text, 'utf8'))) });
  }
  const goFiles: GoPackageFile[] = packageFiles.map((file) => ({ path: file.path, text: file.text, regions: file.access.regions }));
  const index = indexGoPackage(goFiles);
  // What each region of the package reaches directly, by the region's qualified name: the roll-up's first step.
  const regionAccesses = new Map<string, ResolvedSite[]>();
  for (const file of packageFiles) {
    for (const site of file.access.sites) {
      const to = await resolveSite(site);
      if (to === undefined || site.region === '') continue;
      const held = regionAccesses.get(site.region) ?? [];
      held.push({ verb: site.verb, to, via: site.via });
      regionAccesses.set(site.region, held);
    }
  }
  // What each region of the package calls, resolved through the package's own index.
  const resolvedByCaller = new Map<string, { readonly caller: FunctionRegion; readonly calls: ReturnType<typeof resolveGoCalls> }[]>();
  for (const file of packageFiles) {
    const resolved = resolveGoCalls({ path: file.path, text: file.text, regions: file.access.regions }, index);
    for (const region of file.access.regions) {
      const calls = resolved.filter((call) => call.site.path === file.path && within(call, region));
      if (calls.length === 0) continue;
      const held = resolvedByCaller.get(file.path) ?? [];
      held.push({ caller: region, calls });
      resolvedByCaller.set(file.path, held);
    }
  }
  const own = resolvedByCaller.get(path) ?? [];
  for (const { caller, calls } of own) {
    const byFirstHop = new Map<string, ReturnType<typeof resolveGoCalls>[number][]>();
    for (const call of calls) {
      const held = byFirstHop.get(call.callee.qualifiedName) ?? [];
      held.push(call);
      byFirstHop.set(call.callee.qualifiedName, held);
    }
    const from = await symbolKeyOf(stage, sink.repository, path, caller.qualifiedName);
    if (from === undefined) {
      gaps.push({ what: `${path}: line ${String(caller.span.lineStart)}: the roll-up found no symbol node for ${caller.qualifiedName} (${path})`, reason: 'unsupported' });
      continue;
    }
    for (const [firstHop, hopSites] of [...byFirstHop].sort((left, right) => byCodePoint(left[0], right[0]))) {
      const collected = new Map<string, ResolvedSite>();
      const visited = new Set<string>([caller.qualifiedName]);
      const stack = [firstHop];
      while (stack.length > 0) {
        const name = stack.pop()!;
        if (visited.has(name)) continue;
        visited.add(name);
        for (const reach of regionAccesses.get(name) ?? []) collected.set(`${reach.verb} ${reach.to}`, reach);
        for (const entry of [...resolvedByCaller.values()].flat()) {
          if (entry.caller.qualifiedName !== name) continue;
          for (const call of entry.calls) stack.push(call.callee.qualifiedName);
        }
      }
      for (const reach of [...collected.values()].sort((left, right) => byCodePoint(`${left.verb} ${left.to}`, `${right.verb} ${right.to}`))) {
        const type = reach.verb === 'read' ? 'code.reads-table' : 'code.writes-table';
        writeEdge(sink, type, type === 'code.reads-table' ? 'reads-table' : 'writes-table', from, reach.to, {
          via: reach.via,
          callee: firstHop,
          sites: hopSites.map((call) => ({ path: call.site.path, byteStart: call.site.byteStart, byteEnd: call.site.byteEnd, lineStart: call.site.lineStart, lineEnd: call.site.lineEnd })).sort((left, right) => left.byteStart - right.byteStart),
        }, firstHop);
      }
    }
  }
  void direct;
  void symbols;
}

/** Whether a resolved call stands inside a region. */
function within(call: ReturnType<typeof resolveGoCalls>[number], region: FunctionRegion): boolean {
  return call.site.byteStart >= region.span.byteStart && call.site.byteEnd <= region.span.byteEnd;
}

// ---- seed scripts --------------------------------------------------------

/** One seed script's records: the tables its INSERT statements fill, or the gap that says why no one owns them. */
async function seedRecords(sink: Sink, stage: StaticStageContext, path: string, text: string, gaps: CoverageGap[]): Promise<void> {
  const script = await scanScriptWrites(path, text);
  if (script.gap !== undefined) {
    gaps.push({ what: `${script.gap.path}: ${script.gap.reason}`, reason: 'unsupported' });
    return;
  }
  if (!script.recognized && text.trim() !== '') gaps.push({ what: `${path}:1: no PostgreSQL statement could be read`, reason: 'unsupported' });
  if (script.writes.length === 0) return;
  const fileKey = await requireFileNode(stage, sink.repository, path);
  for (const write of script.writes) {
    const owners = (await allByProperty(stage, 'code.table', 'name', write.table))
      .filter((node) => (write.schema === undefined || node.properties['schema'] === write.schema) && (write.catalog === undefined || node.properties['database'] === write.catalog));
    if (owners.length !== 1) {
      const identity = [write.catalog, write.schema, write.table].filter((part) => part !== undefined).join('.');
      gaps.push({ what: `${path}:${String(write.span.lineStart)}: the table ${identity} the script fills is not declared by exactly one database of the tree`, reason: 'unsupported' });
      continue;
    }
    writeEdge(sink, 'code.writes-table', 'writes-table', fileKey, String(owners[0]!.properties['recordKey']), {
      via: 'sql',
      sites: [{ path: write.span.path, byteStart: write.span.byteStart, byteEnd: write.span.byteEnd, lineStart: write.span.lineStart, lineEnd: write.span.lineEnd }],
    });
  }
}

// ---- storage evidence ----------------------------------------------------

/** The key of one storage-evidence record of a file. */
function evidenceKeyOf(repository: string, path: string, sequence: number): string {
  return `code.storage-evidence:${repository}:${path}#${String(sequence)}`;
}

/** One storage-evidence record, and the database it declares. */
function writeEvidence(sink: Sink, database: string, folder: string, kind: string, sequence: number, span: Span, extra: Readonly<Record<string, unknown>>, contributions: Contribution[], phase: 'environment' | 'file' = 'file'): void {
  writeNode(sink, 'code.storage-evidence', 'storage-evidence', evidenceKeyOf(sink.repository, sink.path, sequence), kind, {
    database,
    databaseFolder: folder,
    kind,
    sequence,
    // The driver collects the code files' environment reads before it walks the tree, and its
    // `uses-database` origins keep that order: the aggregate stage sorts by it (madarch-8bdc.2.4).
    phase,
    span: { path: span.path, byteStart: span.byteStart, byteEnd: span.byteEnd, lineStart: span.lineStart, lineEnd: span.lineEnd },
    ...extra,
  }, placeOf(span));
  if (!contributions.some((entry) => entry.folder === folder && entry.name === database)) contributions.push({ folder, name: database });
}

/** Whether a file's name is an environment file the driver reads. */
function environmentFile(path: string): boolean {
  return /^\.?env(?:\.[^/]*)?$/.test(fileName(path));
}

/**
 * The storage evidence one file gives: a storage driver's import or manifest
 * dependency, an environment file's connection setting, a compose service's
 * deployment connection, or a code file's environment read. Each is the
 * driver's own rule, read from this file's bytes and the code facts the
 * code-facts stage published; the record names the database it declares and the
 * place it stands at, and the aggregate stage assembles the database from them.
 */
async function evidenceRecords(sink: Sink, stage: StaticStageContext, path: string, text: string, bytes: number, gaps: CoverageGap[], contributions: Contribution[]): Promise<void> {
  const membership = await membershipOf(stage, path);
  const name = fileName(path);
  const service = membership?.name;
  const codeSource = driverLanguageOf(path) !== null;
  const source = service !== undefined && (codeSource || name === 'package.json' || name === 'go.mod' || environmentFile(path));
  let sequence = 0;
  const folderOfService = membership?.root ?? '';
  if (source && service !== undefined) {
    if (codeSource) {
      const syntax = await extractFileSyntax(path, new Uint8Array(Buffer.from(text, 'utf8')));
      for (const imported of syntax.imports) {
        if (!STORAGE_DRIVER_IMPORT.test(imported.specifier)) continue;
        writeEvidence(sink, service, folderOfService, 'driver', sequence++, { path, byteStart: imported.span.startByte, byteEnd: imported.span.endByte, lineStart: imported.span.startLine, lineEnd: imported.span.endLine }, {}, contributions);
      }
      await environmentReadEvidence(sink, stage, path, service, folderOfService, sequence, gaps, contributions);
      sequence += 1;
    } else if (name === 'package.json') {
      try {
        const manifest = JSON.parse(text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        for (const dependency of Object.keys({ ...manifest.devDependencies, ...manifest.dependencies }).sort(byCodePoint)) {
          if (!STORAGE_DRIVER_IMPORT.test(dependency)) continue;
          const at = text.indexOf(JSON.stringify(dependency));
          if (at < 0) continue;
          const start = byteOf(text, at);
          writeEvidence(sink, service, folderOfService, 'driver', sequence++, { path, byteStart: start, byteEnd: start + dependency.length + 2, lineStart: lineOf(text, at), lineEnd: lineOf(text, at) }, {}, contributions);
        }
      } catch (error) {
        gaps.push({ what: `${path}:1: storage evidence cannot read package.json: ${error instanceof Error ? error.message : String(error)}`, reason: 'error' });
      }
    } else if (name === 'go.mod') {
      const manifest = readGoMod(text);
      if (manifest.ok) {
        for (const entry of manifest.value.requires) {
          if (!STORAGE_DRIVER_IMPORT.test(entry.path)) continue;
          const lines = text.split('\n');
          const start = lines.slice(0, entry.line - 1).join('\n').length + (entry.line > 1 ? 1 : 0);
          writeEvidence(sink, service, folderOfService, 'driver', sequence++, { path, byteStart: start, byteEnd: start + (lines[entry.line - 1]?.length ?? 0), lineStart: entry.line, lineEnd: entry.line }, {}, contributions);
        }
      }
    } else if (environmentFile(path)) {
      try {
        const variables = parseEnv(text);
        if (Object.keys(variables).length === 0 && text.split('\n').some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))) {
          gaps.push({ what: `${path}:1: environment parser returned no assignments for non-comment configuration; connection evidence is unresolved (${path})`, reason: 'unsupported' });
        }
        for (const variable of Object.keys(variables).sort(byCodePoint)) {
          const model = environmentModels.find((entry) => entry.variable === variable);
          if (model === undefined || variables[variable] === '') continue;
          writeEvidence(sink, service, folderOfService, 'connection-setting', sequence++, { path, byteStart: 0, byteEnd: bytes, lineStart: 1, lineEnd: text.split('\n').length }, { environmentModel: model.id }, contributions);
        }
      } catch (error) {
        gaps.push({ what: `${path}:1: environment configuration cannot be parsed: ${error instanceof Error ? error.message : String(error)} (${path})`, reason: 'error' });
      }
    }
  }
  if (composeFile(path)) await composeEvidence(sink, stage, path, text, gaps, contributions);
}

/** The byte offset a character offset stands at, in UTF-8 bytes. */
function byteOf(text: string, character: number): number {
  return new TextEncoder().encode(text.slice(0, character)).length;
}

/** The 1-based line a character offset stands on. */
function lineOf(text: string, character: number): number {
  let line = 1;
  for (let index = 0; index < character; index++) if (text[index] === '\n') line++;
  return line;
}

/** The environment reads one code file's own facts prove, as the driver records them. */
async function environmentReadEvidence(sink: Sink, stage: StaticStageContext, path: string, service: string, folder: string, start: number, gaps: CoverageGap[], contributions: Contribution[]): Promise<void> {
  const effects = await libraryEffectsOf(stage, sink.repository, path);
  // The closure the effects chained through are files this unit read: one of them moving re-reads this unit
  // (decision 0033, item 15), which the coverage below records (`Sink.read`).
  for (const file of effects.closure.files) sink.read.add(file);
  const symbols = (await allByProperty(stage, 'code.symbol', 'file', path))
    .filter((node) => node.properties['repository'] === sink.repository && isCallable(node.properties))
    .map((node) => ({ key: String(node.properties['recordKey']), properties: node.properties }));
  let sequence = start;
  for (const effect of effects.effects) {
    if (effect.kind !== 'env-read' || effect.span.path !== path) continue;
    const nameArgument = effect.arguments.find((argument) => argument.name === 'name');
    const value = nameArgument?.expression === undefined ? undefined : await expressionValue(stage, nameArgument.expression);
    if (typeof value !== 'string') {
      gaps.push({ what: `${path}:${String(effect.span.lineStart)}: environment variable name is unresolved`, reason: 'unsupported' });
      continue;
    }
    const model = environmentModels.find((entry) => entry.variable === value);
    if (model === undefined) continue;
    const canonical = canonicalHolder(symbols, effect.span, path);
    if (canonical === undefined) {
      gaps.push({ what: `${path}:${String(effect.span.lineStart)}: environment read has no unique canonical callable owner`, reason: 'unsupported' });
      continue;
    }
    const expression = await driverExpressionId(stage, effect.expression, path);
    writeEvidence(sink, service, folder, 'connection-setting', sequence++, { path, byteStart: effect.span.byteStart, byteEnd: effect.span.byteEnd, lineStart: effect.span.lineStart, lineEnd: effect.span.lineEnd }, {
      environmentModel: model.id,
      ...(expression === undefined ? {} : { expression }),
      holder: canonical,
    }, contributions, 'environment');
  }
}

/** The string value one expression node holds, where it holds a literal. */
async function expressionValue(stage: StaticStageContext, id: string): Promise<string | undefined> {
  const held = await stage.byKey(id, { limit: 2 });
  const literal = held[0]?.properties['literal'];
  const value = literal !== null && typeof literal === 'object' ? (literal as Record<string, unknown>)['value'] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** The driver's own expression id for one expression node: its path, bytes and syntax kind. */
async function driverExpressionId(stage: StaticStageContext, id: string, path: string): Promise<string | undefined> {
  const held = await stage.byKey(id, { limit: 2 });
  const properties = held[0]?.properties;
  if (properties === undefined) return undefined;
  const span = properties['span'];
  const syntaxKind = properties['syntaxKind'];
  if (span === null || typeof span !== 'object' || typeof syntaxKind !== 'string') return undefined;
  const held_span = span as Record<string, unknown>;
  if (typeof held_span['byteStart'] !== 'number' || typeof held_span['byteEnd'] !== 'number') return undefined;
  return `${path}:${String(held_span['byteStart'])}:${String(held_span['byteEnd'])}:${syntaxKind}`;
}

/** The driver's canonical holder of one place: the innermost callable symbol's key, or the file's own, refused where two stand at one span. */
function canonicalHolder(symbols: readonly { readonly key: string; readonly properties: Readonly<Record<string, unknown>> }[], span: { readonly path: string; readonly byteStart: number; readonly byteEnd: number }, path: string): string | undefined {
  const held = symbols.filter((symbol) => {
    const place = symbolPlaceOf(symbol.properties);
    return place !== undefined && place.byteStart <= span.byteStart && span.byteEnd <= place.byteEnd;
  }).sort((left, right) => {
    const leftPlace = symbolPlaceOf(left.properties)!;
    const rightPlace = symbolPlaceOf(right.properties)!;
    return (leftPlace.byteEnd - leftPlace.byteStart) - (rightPlace.byteEnd - rightPlace.byteStart) || byCodePoint(left.key, right.key);
  });
  const owner = held[0];
  if (owner === undefined) return `code.file:${path}`;
  if (held.some((candidate) => candidate.key !== owner.key && sameSpan(candidate.properties, owner.properties))) return undefined;
  const qualified = owner.properties['qualifiedName'];
  return typeof qualified === 'string' ? `code.symbol:${path}#${qualified}` : `code.file:${path}`;
}

/** Whether two symbol nodes stand at one byte span. */
function sameSpan(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  const one = symbolPlaceOf(left);
  const other = symbolPlaceOf(right);
  return one !== undefined && other !== undefined && one.byteStart === other.byteStart && one.byteEnd === other.byteEnd;
}

/** The deployment connections one compose file declares, for the services that are units of the tree. */
async function composeEvidence(sink: Sink, stage: StaticStageContext, path: string, text: string, gaps: CoverageGap[], contributions: Contribution[]): Promise<void> {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  if (doc.errors.length > 0) {
    for (const error of doc.errors) gaps.push({ what: `${path}:${String(lc.linePos(error.pos[0]).line)}: ${error.message}`, reason: 'error' });
    return;
  }
  if (!isMap(doc.contents)) return;
  const services = doc.contents.get('services', true);
  if (!isMap(services)) return;
  let sequence = 0;
  for (const pair of services.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isMap(pair.value)) continue;
    const service = pair.key.value;
    const units = await allByProperty(stage, 'code.service-unit', 'name', service);
    if (units.length === 0) continue;
    const folder = typeof units[0]!.properties['root'] === 'string' ? String(units[0]!.properties['root']) : '';
    const environment = pair.value.get('environment', true);
    if (!isMap(environment)) continue;
    for (const item of environment.items) {
      if (!isScalar(item.key) || typeof item.key.value !== 'string') continue;
      const variable = String(item.key.value);
      const model = environmentModels.find((entry) => entry.variable === variable);
      if (model === undefined) continue;
      if (!isScalar(item.value) || typeof item.value.value !== 'string') continue;
      const range = item.value.range ?? item.key.range;
      if (range == null || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] <= range[0] || range[1] > text.length) {
        gaps.push({ what: `${path}:1: deployment connection setting ${variable} of service ${service} has no valid source range; no storage evidence is created`, reason: 'unsupported' });
        continue;
      }
      const bytes = new ByteText(text);
      const byteStart = bytes.byteAt(range[0]);
      const byteEnd = bytes.byteAt(range[1]);
      writeEvidence(sink, service, folder, 'deployment-connection', sequence++, { path, byteStart, byteEnd, lineStart: bytes.lineOf(byteStart), lineEnd: bytes.lineOf(byteEnd) }, { environmentModel: model.id }, contributions);
    }
  }
}

// ---- the aggregate stage: one database ----------------------------------

/**
 * The stage over the source that holds the run's pins: the records one file
 * cannot own. Its unit is one database, named by the unit that declares it, and
 * every record it publishes stands on the per-file stage's own records read
 * through bounded reads — never on a file the unit did not own.
 */
export function createDataModelAggregateStage(sources: SnapshotSource): FillStage {
  return {
    id: DATA_MODEL_AGGREGATE_STAGE_ID,
    version: 1,
    staticReading: true,
    // The records this stage assembles are the per-file stage's own: its migrations, tables,
    // columns, schema readings and storage evidence. The registry derives this stage after that
    // one, and the run plans it in the epoch after those publications.
    consumes: {
      required: [
        { capability: 'migration', scope: 'repository', freshness: 'current' },
        { capability: 'storage-evidence', scope: 'repository', freshness: 'current' },
        // The service that uses a database is the one operations-links publishes, so this stage
        // stands after it: a database names `code.service:<name>` as its use edge's source.
        { capability: 'service', scope: 'repository', freshness: 'current' },
      ],
      optional: [
        { capability: 'column', scope: 'repository', freshness: 'current' },
        { capability: 'table', scope: 'repository', freshness: 'current' },
        { capability: 'schema-reading', scope: 'repository', freshness: 'current' },
      ],
    },
    produces: [
      { kind: 'database', schemaVersion: 1, scope: 'file' },
      { kind: 'holds', schemaVersion: 1, scope: 'file' },
      { kind: 'logical-reference', schemaVersion: 1, scope: 'file' },
      { kind: 'uses-database', schemaVersion: 1, scope: 'file' },
      { kind: 'contains', schemaVersion: 1, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planDatabaseAggregates(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeDatabaseUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(DATA_MODEL_AGGREGATE_STAGE_ID, AGGREGATE_KINDS, draft),
  };
}

/** One database the per-file stage contributed to: the name the driver gives it and the folder its first file stands in. */
interface DatabaseContribution {
  readonly folder: string;
  readonly name: string;
}

/** The read of one database's inputs: the kinds the aggregate assembles, as the graph holds them. */
function databaseInputsRead(repository: string, database: string): string {
  return JSON.stringify({ read: DATA_MODEL_DATABASE_INPUTS_READ, repository, database });
}

/** The kinds one database's inputs are read by, in code point order. */
const DATABASE_INPUT_KINDS: readonly string[] = ['code.column', 'code.migration', 'code.schema-reading', 'code.storage-evidence', 'code.table'];

/** One row of a database's inputs: the node the graph holds. */
interface InputRow {
  readonly id: string;
  readonly kind: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** The digest of one database's inputs: what tells a plan that the database's records moved. */
function inputsDigest(rows: readonly InputRow[]): string {
  const held = rows.map((row) => ({
    kind: row.kind,
    recordKey: String(row.properties['recordKey'] ?? row.id),
    properties: Object.fromEntries(Object.keys(row.properties).filter((key) => key !== 'provenance').sort().map((key) => [key, row.properties[key]])),
  }));
  held.sort((left, right) => byCodePoint(`${left.kind} ${left.recordKey}`, `${right.kind} ${right.recordKey}`));
  return canonicalJsonDigest(held);
}

/** One database's inputs, read through the static context. */
async function databaseInputsAt(stage: StaticStageContext, database: string): Promise<readonly InputRow[]> {
  const rows: InputRow[] = [];
  for (const kind of DATABASE_INPUT_KINDS) {
    for (const row of await allByProperty(stage, kind, 'database', database)) rows.push({ id: row.id, kind: row.kind, properties: row.properties });
  }
  return rows;
}

/** One database's inputs, read through the plan's graph reader: the dedicated read pages its own answer. */
async function databaseInputsOfPlan(graph: StageGraphReader, repository: string, database: string): Promise<readonly InputRow[]> {
  const read = databaseInputsRead(repository, database);
  const rows = await graph.query(read);
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'the nodes one database is assembled from');
    const kind = held['kind'];
    const id = held['id'];
    const properties = held['properties'];
    if (typeof kind !== 'string' || typeof id !== 'string' || properties === null || typeof properties !== 'object') {
      throw refuseRow(read, index, repository, 'it names no kind, id and properties: a row is the node the graph holds');
    }
    return { id, kind, properties: properties as Record<string, unknown> };
  });
}

/** One unit's database, from its unit id: `database:<repository>:<name>`. */
function plannedDatabase(unitId: string): { readonly repository: string; readonly database: string } {
  const prefix = 'database:';
  if (!unitId.startsWith(prefix)) throw new Error(`the unit id ${JSON.stringify(unitId)} is not one this stage plans, and a unit id is "database:<repository>:<name>" (src/fill/stages/data-model.ts)`);
  const rest = unitId.slice(prefix.length);
  const at = rest.indexOf(':');
  if (at < 0) throw new Error(`the unit id ${JSON.stringify(unitId)} names no database, and a unit id is "database:<repository>:<name>" (src/fill/stages/data-model.ts)`);
  return { repository: rest.slice(0, at), database: rest.slice(at + 1) };
}

/**
 * The aggregate units one run fills: one per database the per-file stage
 * contributed records to, planned when the database's inputs moved since the
 * coverage the stage published, or when it published none. A database is the
 * unit the driver names it by (`orders`), so two folders of one unit are one
 * database and one unit.
 */
async function planDatabaseAggregates(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let any = false;
  for (const pin of pins) {
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const fileRead = JSON.stringify({ read: DATA_MODEL_PUBLISHED_READ, repository: pin.id });
    const files = publishedDataModelRows(await graph.query(fileRead), pin.id, fileRead);
    const contributions = new Map<string, string>();
    for (const row of files) for (const database of row.databases ?? []) {
      const held = contributions.get(database.name);
      if (held === undefined || byCodePoint(database.folder, held) < 0) contributions.set(database.name, database.folder);
    }
    const ownRead = JSON.stringify({ read: DATA_MODEL_AGGREGATE_PUBLISHED_READ, repository: pin.id });
    const own = publishedDatabaseRows(await graph.query(ownRead), pin.id, ownRead);
    const covered = new Map(own.map((row) => [row.database, row.digest]));
    any = any || contributions.size > 0;
    for (const name of [...contributions.keys()].sort(byCodePoint)) {
      const folder = contributions.get(name)!;
      // A folder the commit no longer holds publishes nothing, and its publication retracts
      // the database an earlier run assembled there.
      const present = folder === '' || [...tree.directories].some((directory) => directory === folder || directory.startsWith(`${folder}/`)) || [...tree.files.keys()].some((path) => path.startsWith(`${folder}/`));
      if (!present) {
        units.push({ id: `database:${pin.id}:${name}`, scope: `${pin.id}:${name}` });
        continue;
      }
      const digest = inputsDigest(await databaseInputsOfPlan(graph, pin.id, name));
      if (covered.get(name) === digest) continue;
      units.push({ id: `database:${pin.id}:${name}`, scope: `${pin.id}:${name}` });
    }
  }
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: any ? 'planned' : 'nothing-found' };
}

/** One row of the aggregate read, read. */
function publishedDatabaseRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedDatabaseRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'the databases this stage assembled');
    unknownKeys(held, DATABASE_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const database = held['database'];
    if (typeof database !== 'string' || database === '') throw refuseRow(read, index, repository, `its database ${JSON.stringify(database)} is no database name`);
    const digest = held['digest'];
    if (typeof digest !== 'string' || digest === '') throw refuseRow(read, index, repository, `its digest ${JSON.stringify(digest)} is no digest: the inputs the database was assembled from`);
    return { kind: 'coverage', database, digest };
  });
}

/** One record's span, as a storage-evidence or schema-reading node carries it. */
function spanOfRecord(properties: Readonly<Record<string, unknown>>): Span | undefined {
  const span = properties['span'];
  if (span === null || typeof span !== 'object') return undefined;
  const held = span as Record<string, unknown>;
  if (typeof held['path'] !== 'string' || typeof held['byteStart'] !== 'number' || typeof held['byteEnd'] !== 'number' || typeof held['lineStart'] !== 'number' || typeof held['lineEnd'] !== 'number') return undefined;
  return { path: held['path'], byteStart: held['byteStart'], byteEnd: held['byteEnd'], lineStart: held['lineStart'], lineEnd: held['lineEnd'] };
}

/** The rank a schema reading stands at in the driver's origins: its migrations, then its schema, then its code's own declarations. */
function readingRank(kind: string): number {
  return kind === 'migration' ? 0 : kind === 'prisma' ? 1 : 2;
}

/**
 * One database's unit: the database node with the evidence that declares it,
 * what it contains and holds, the logical references its columns make into
 * another database, and the service that uses it — assembled from the per-file
 * stage's published records through bounded reads, and from nothing wider.
 */
async function executeDatabaseUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedDatabase(unit.id);
  const stage = staticSourceOf(unit, context);
  const source = stage.repository;
  refuseWhenCancelled(unit, context);
  const name = planned.database;
  const rows = await databaseInputsAt(stage, name);
  const gaps: CoverageGap[] = [];
  const evidence = rows.filter((row) => row.kind === 'code.storage-evidence')
    .map((row) => ({ row, span: spanOfRecord(row.properties), kind: String(row.properties['kind'] ?? ''), sequence: Number(row.properties['sequence'] ?? 0), phase: String(row.properties['phase'] ?? 'file') }))
    .filter((entry): entry is { row: InputRow; span: Span; kind: string; sequence: number; phase: string } => entry.span !== undefined)
    // The driver collects the code files' environment reads before it walks the tree, and its
    // origins keep that order: environment reads first, then the tree's files by path.
    .sort((left, right) => (left.phase === right.phase ? 0 : left.phase === 'environment' ? -1 : 1) || byCodePoint(left.span.path, right.span.path) || left.sequence - right.sequence);
  const migrations = rows.filter((row) => row.kind === 'code.migration')
    .sort((left, right) => Number(Boolean(left.properties['prisma'])) - Number(Boolean(right.properties['prisma'])) || byCodePoint(String(left.properties['name'] ?? ''), String(right.properties['name'] ?? '')));
  const readings = rows.filter((row) => row.kind === 'code.schema-reading')
    .map((row) => ({ row, span: spanOfRecord(row.properties), kind: String(row.properties['kind'] ?? ''), ordinal: Number(row.properties['ordinal'] ?? 0), sequence: Number(row.properties['sequence'] ?? 0) }))
    .filter((entry): entry is { row: InputRow; span: Span; kind: string; ordinal: number; sequence: number } => entry.span !== undefined)
    .sort((left, right) => readingRank(left.kind) - readingRank(right.kind) || left.ordinal - right.ordinal || left.sequence - right.sequence);
  const tables = rows.filter((row) => row.kind === 'code.table')
    .sort((left, right) => byCodePoint(String(left.properties['name'] ?? ''), String(right.properties['name'] ?? '')));
  const columns = rows.filter((row) => row.kind === 'code.column');
  // The database's place is the file that declares it: its first migration, its schema, or the
  // evidence that named it (the driver's own rule). The schema is the file a Prisma reading
  // stands in, so no read of another stage's coverage is needed to find it.
  const declaredIn = migrations[0]?.properties['path'] ?? readings.find((entry) => entry.kind === 'prisma')?.span.path;
  const sink: Sink = { repository: planned.repository, commit: source.commit, source: AGGREGATE_SOURCE, path: typeof declaredIn === 'string' ? declaredIn : evidence[0]?.span.path ?? '.', writes: [], read: new Set(), seenNodes: new Set(), seenEdges: new Set() };
  let place: Place | undefined;
  if (typeof declaredIn === 'string') {
    const read = await readTextOf(stage, declaredIn);
    place = read.ok ? wholeFilePlace(declaredIn, read.text, read.bytes) : undefined;
    if (place === undefined) gaps.push({ what: `${declaredIn}: the database's first file could not be read, so the database's place is its evidence`, reason: 'unsupported' });
  }
  if (place === undefined && evidence[0] !== undefined) place = placeOf(evidence[0].span);
  if (place === undefined) {
    gaps.push({ what: `${name}: the database has no place it is declared at`, reason: 'unsupported' });
    writeDatabaseCoverage(context, source, planned.repository, name, sink.path, inputsDigest(rows), gaps);
    return { outcome: 'draft' };
  }
  const database = databaseKey(name);
  const evidenceKind = typeof declaredIn === 'string' ? 'schema' : evidence[0]?.kind ?? 'schema';
  writeNode(sink, 'code.database', 'database', database, name, {
    service: name,
    path: place.file,
    evidenceKind,
    evidence: evidence.map((entry) => ({ kind: entry.kind, path: entry.span.path, line: entry.span.lineStart })),
  }, place);
  // The driver's reading cites the database in the file its place stands in: the first migration's
  // whole file holds the database node, beside the database's own containment of its migrations.
  writeEdge(sink, 'code.contains', 'contains', fileFactIdOf(planned.repository, place.file), database, {});
  for (const migration of migrations) {
    writeEdge(sink, 'code.contains', 'contains', database, String(migration.properties['recordKey']), {});
  }
  for (const table of tables) {
    writeEdge(sink, 'code.holds', 'holds', database, String(table.properties['recordKey']), {});
  }
  // The logical references: a `_id` column of this database's tables that names the one table of
  // another database the column's entity spells, and is no foreign key (the driver's own rule).
  for (const table of tables) {
    const tableName = String(table.properties['name'] ?? '');
    if (tableName === '') continue;
    const schema = typeof table.properties['schema'] === 'string' ? String(table.properties['schema']) : 'public';
    for (const column of columns.filter((entry) => entry.properties['table'] === tableName).sort((left, right) => byCodePoint(String(left.properties['name'] ?? ''), String(right.properties['name'] ?? '')))) {
      const columnName = String(column.properties['name'] ?? '');
      if (!columnName.endsWith('_id') || column.properties['foreignKey'] === true) continue;
      const entity = columnName.slice(0, -'_id'.length);
      if (entity === '') continue;
      for (const candidate of [entity, `${entity}s`, `${entity}es`]) {
        const targets = (await allByProperty(stage, 'code.table', 'name', candidate)).filter((node) => node.properties['database'] !== name);
        if (targets.length !== 1) continue;
        const target = targets[0]!;
        const targetDatabase = String(target.properties['database']);
        const targetSchema = typeof target.properties['schema'] === 'string' ? String(target.properties['schema']) : 'public';
        const targetColumns = (await allByProperty(stage, 'code.column', 'table', candidate)).filter((node) => node.properties['database'] === targetDatabase);
        const primary = targetColumns.filter((node) => node.properties['primaryKey'] === true).map((node) => String(node.properties['name'] ?? ''));
        const targetColumn = primary.length === 1 ? primary[0] : targetColumns.some((node) => node.properties['name'] === 'id') ? 'id' : undefined;
        writeEdge(sink, 'code.logical-reference', 'logical-reference', tableKey(name, tableName, schema), tableKey(targetDatabase, candidate, targetSchema), {
          column: columnName,
          ...(targetColumn === undefined ? {} : { targetColumn }),
          targetDatabase,
        }, columnName);
        break;
      }
    }
  }
  // The service that uses the database: the operations-links stage publishes one node per unit,
  // `code.service:<name>`, and this stage's dependency on the `service` kind makes it stand before
  // this unit runs. The driver names the same key, so the edge's source is that key directly.
  const service = `code.service:${name}`;
  writeEdge(sink, 'code.uses-database', 'uses-database', service, database, {
    via: readings.length > 0 ? 'schema' : evidence[0]?.kind ?? 'schema',
    origins: [
      ...evidence.map((entry) => ({
        sourceProducer: 'code.extract.data-model',
        originalDiscriminator: '',
        sourceSpan: { path: entry.span.path, byteStart: entry.span.byteStart, byteEnd: entry.span.byteEnd, lineStart: entry.span.lineStart, lineEnd: entry.span.lineEnd },
        properties: {
          via: entry.kind,
          ...(typeof entry.row.properties['environmentModel'] === 'string' ? { environmentModel: entry.row.properties['environmentModel'] } : {}),
          ...(typeof entry.row.properties['expression'] === 'string' ? { expression: entry.row.properties['expression'] } : {}),
          ...(typeof entry.row.properties['holder'] === 'string' ? { holder: entry.row.properties['holder'] } : {}),
        },
      })),
      ...readings.map((entry) => ({
        sourceProducer: 'code.extract.data-model',
        originalDiscriminator: '',
        sourceSpan: { path: entry.span.path, byteStart: entry.span.byteStart, byteEnd: entry.span.byteEnd, lineStart: entry.span.lineStart, lineEnd: entry.span.lineEnd },
        properties: { via: 'schema' },
      })),
    ],
  });
  for (const write of sink.writes) context.draft.write(write);
  writeDatabaseCoverage(context, source, planned.repository, name, sink.path, inputsDigest(rows), gaps);
  context.progress(`assembled the database ${name} of ${planned.repository}: ${String(evidence.length)} evidence readings, ${String(migrations.length)} migrations, ${String(tables.length)} tables`, 1);
  return { outcome: 'draft' };
}

/** One database's coverage: the digest of the inputs it was assembled from, so a plan reads whether they moved. */
function writeDatabaseCoverage(context: StageContext, source: StaticStageSource, repository: string, name: string, path: string, digest: string, gaps: CoverageGap[]): void {
  const coverage: CoverageValue = { repository, scope: name, complete: gaps.length === 0, read: [], unread: orderedGaps(gaps) };
  const fact = makeNodeFact({ kind: 'coverage', layer: 'extracted', provenance: { source: AGGREGATE_SOURCE, repository: { id: repository, commit: source.commit } }, value: coverage });
  for (const write of graphWritesOf(fact, evidenceAtPlace({ repository, commit: source.commit }, path === '.' ? undefined : path))) {
    context.draft.write(write.kind === 'node' ? { ...write, value: { ...write.value, properties: { ...write.value.properties, digest } } } : write);
  }
}
