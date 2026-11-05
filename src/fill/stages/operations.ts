/**
 * The operations reading of one file, as a static stage (decision 0033, items 5,
 * 14 and 15; madarch-8bdc.2.4): one unit per file, the file's own bytes, and the
 * records of the operations area whose span stands in that file.
 *
 * **What it publishes.** The extract driver's operations extractor reads one
 * whole tree into one `Extraction` (decision 0028): the manifests and their
 * dependencies, the lock files, the Dockerfiles and the ports they expose, the
 * compose services, the Kubernetes workloads and their probes, the Makefile's
 * targets, the CI workflows and their jobs, the environment definitions, the
 * broker images, the loggers and the endpoints, the newcomer's first run, and
 * the services those readings describe. A static stage may hold neither the
 * tree nor that object (decision 0033, item 5), so this stage publishes the
 * same records from one file at a time, with the driver's own keys, kinds,
 * labels, properties and spans — the comparison in
 * `test/fill-operations-training.test.ts` is what names every difference.
 *
 * **The rule that makes the port exact.** A record is owned by the file its
 * `span` stands in: the file whose bytes it cites. A unit publishes exactly the
 * records it owns, and nothing else. Where a record needs a fact of another
 * file, the unit reads it through the static context — a path-scoped entry, one
 * file's facts by property, or one node by key — never a listing of the tree.
 *
 * **The plan's order is the publication order.** The orchestrator admits one
 * stage's units in the plan's own order (its `concurrency` is one by decision
 * 0027, and the ageing subtracts the same wait from every unit of one plan), so
 * the plan lists the files in the order the driver reads its areas: the lock
 * files and manifests first, then the Dockerfiles that declare the ports, then
 * the compose and Kubernetes files, then the build files, and the code files
 * last. A unit whose edge ends at a node another unit publishes therefore finds
 * that node in the graph, and no unit publishes a node twice.
 *
 * **A shared node has one owner.** A port, an image or a service is named by
 * several files and published by the first of them in the plan's order; a later
 * unit reads it by key and names it as its edge's end without publishing it
 * again (an owner is one producer and one scope, and the store fences a second
 * one — `src/graph/publish.ts`).
 *
 * **What a unit publishes when it cannot read.** A path the commit no longer
 * holds publishes nothing, and the publication retracts what the unit wrote. A
 * file above the static cap and bytes that are not UTF-8 are named in the file's
 * coverage — a gap, never a silence.
 *
 * **A refill writes nothing.** The plan compares each file's blob with this
 * stage's own coverage; a file it already read at the blob the pinned commit
 * holds is not planned again.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { isRepositoryPath, makeNodeFact, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { evidenceAtPlace, refuseRow, rowRecord, unknownKeys } from './draft.js';
import { STATIC_READ_ROW_LIMIT, STATIC_FILE_BYTE_LIMIT, type StaticGraphNode, type StaticStageContext, type StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';
import { serviceMembershipOf, type ManifestEntry } from './service-membership.js';
import { libraryEffectsOf } from './library-effects.js';
import { envReadsOf, type EnvBinding, type EnvCall, type EnvExpression, type EnvRead, type EnvSpan } from './env-reads.js';
import {
  FileText, RecordSet, asyncapiRecords, brokerOf, composeRecords, dockerfileRead, dockerfileRecords, environmentRecords, goModReading, goSumRecords,
  imageServiceName, k8sRecords, makefileRecords, newcomerRecords, npmLockRecords, npmManifestReading, processRecords,
  recordsOf, startedProcessOf, usesDependencyRecords, workflowRecords, type BrokerRow,
  type FileRecords, type NodeRecord, type RecordSpan,
} from './operations-records.js';

/** The stage's id, as it is registered and as its units are named. */
export const OPERATIONS_STAGE_ID = 'operations';

/** The stage's own version, bumped when what it reads, plans or writes changes. */
const OPERATIONS_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order: one per record kind it writes today. */
const OPERATIONS_STAGE_KINDS: readonly string[] = [
  'backed-by', 'broker', 'builds', 'built-by', 'ci-job', 'ci-workflow', 'compose-service', 'configured-by',
  'contains', 'contains-job', 'coverage', 'declares-dependency', 'defined-in', 'dependency', 'depends-on',
  'dockerfile', 'env-definition', 'env-read', 'exposes', 'healthcheck', 'hosts-channel', 'image', 'k8s-deployment', 'k8s-service',
  'listens-on', 'lockfile', 'make-target', 'manifest', 'newcomer-command', 'newcomer-failure',
  'newcomer-prerequisites', 'port', 'probe', 'process', 'publishes', 'references', 'resolves', 'runs', 'starts',
  'targets', 'uses-dependency',
];

/** The reader every fact of this stage cites: this fill's own reading of one file's operations records. */
const OPERATIONS_SOURCE: FactSource = { system: 'madarch-operations', version: '1' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_OPERATIONS_READ = 'stage-operations-published';

/** The read of one repository's published operations coverage: one row per file this stage read, at the blob it stood under. */
function publishedOperationsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_OPERATIONS_READ, repository });
}

/** One row of that read: one file this stage read, at the blob its bytes stood under. */
export interface PublishedOperationsRow {
  readonly kind: 'coverage';
  readonly file: string;
  readonly blob: string;
}

/** The keys a row of that read holds, and no others. */
const OPERATIONS_ROW_FIELDS: readonly string[] = ['blob', 'file', 'kind'];

/**
 * The families of files this stage reads, in the order the driver reads its
 * areas: a file's rank is its place in the plan, and the plan's order is the
 * publication order (`admissionOrder`, decision 0027).
 */
const FAMILY_RANK: Readonly<Record<string, number>> = {
  lockfile: 1,
  manifest: 2,
  dockerfile: 3,
  // The code files come before the files that link to what they read: a compose service's
  // environment definition names the variable a code file reads (`code.defines`), and a
  // probe claims the health endpoint a code file serves (`code.probes`). Both nodes are
  // published by the code file, whose unit is planned before the file that names it.
  code: 4,
  compose: 5,
  kubernetes: 6,
  makefile: 7,
  workflow: 8,
  'environment': 9,
  document: 10,
  asyncapi: 11,
};

/** The families this stage reads today: the ones whose records it publishes. */
const FAMILIES_READ: readonly string[] = ['lockfile', 'manifest', 'dockerfile', 'code', 'compose', 'kubernetes', 'makefile', 'workflow', 'environment', 'document', 'asyncapi'];

/** The name a path's last leg carries, as a file name. */
function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Whether a path is one of the lock files this stage reads. */
function isLockfile(path: string): boolean {
  const name = baseNameOf(path);
  return name === 'package-lock.json' || name === 'go.sum';
}

/** Whether a path is one of the manifests this stage reads. */
function isManifest(path: string): boolean {
  if (path.split('/').includes('node_modules')) return false;
  const name = baseNameOf(path);
  return name === 'package.json' || name === 'go.mod';
}

/** Whether a path is a Dockerfile, by the name Docker builds a file under. */
function isDockerfile(path: string): boolean {
  const name = baseNameOf(path);
  return name === 'Dockerfile' || name.startsWith('Dockerfile.');
}

/** Whether a path is a compose file, by the names compose reads. */
function isCompose(path: string): boolean {
  const name = baseNameOf(path);
  if (!name.endsWith('.yml') && !name.endsWith('.yaml')) return false;
  const stem = name.slice(0, name.lastIndexOf('.'));
  return stem === 'compose' || stem === 'docker-compose' || stem.startsWith('compose.') || stem.startsWith('docker-compose.');
}

/** Whether a path is a Kubernetes file: a YAML document under the `deploy` folder. */
function isKubernetes(path: string): boolean {
  return (path.startsWith('deploy/') || path === 'deploy') && (path.endsWith('.yml') || path.endsWith('.yaml'));
}

/** Whether a path is a Makefile. */
function isMakefile(path: string): boolean {
  return baseNameOf(path) === 'Makefile';
}

/** Whether a path is a CI workflow: a YAML document of the workflows folder. */
function isWorkflow(path: string): boolean {
  return path.startsWith('.github/workflows/') && (path.endsWith('.yml') || path.endsWith('.yaml'));
}

/** Whether a path is an environment example: the dotenv file a repository documents its settings in. */
function isEnvironment(path: string): boolean {
  return baseNameOf(path) === '.env.example';
}

/** Whether a path is the repository's newcomer document: the README the first run is read from. */
function isNewcomerDocument(path: string): boolean {
  const name = baseNameOf(path);
  return name === 'README.md' && !path.includes('/');
}

/** Whether a path is an AsyncAPI document. */
function isAsyncapi(path: string): boolean {
  return path.startsWith('contracts/asyncapi/') && (path.endsWith('.yml') || path.endsWith('.yaml'));
}

/** Whether a path is a code file this stage reads: the source of a Go or TypeScript unit. */
function isCode(path: string): boolean {
  return path.endsWith('.go') || /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path);
}

/** The family a path belongs to, where this stage reads it at all. */
export function operationsFamilyOf(path: string): string | undefined {
  if (isLockfile(path)) return 'lockfile';
  if (isManifest(path)) return 'manifest';
  if (isDockerfile(path)) return 'dockerfile';
  if (isCompose(path)) return 'compose';
  if (isKubernetes(path)) return 'kubernetes';
  if (isMakefile(path)) return 'makefile';
  if (isWorkflow(path)) return 'workflow';
  if (isEnvironment(path)) return 'environment';
  if (isNewcomerDocument(path)) return 'document';
  if (isAsyncapi(path)) return 'asyncapi';
  if (isCode(path)) return 'code';
  return undefined;
}

/** The stage, built over the source that holds the run's pins. */
export function createOperationsStage(sources: SnapshotSource): FillStage {
  return {
    id: OPERATIONS_STAGE_ID,
    version: OPERATIONS_STAGE_VERSION,
    staticReading: true,
    // The file nodes stage 0 published are what a unit hangs its records from: a graph
    // without them starves this stage by name.
    consumes: {
      required: [{ capability: 'file', scope: 'repository', freshness: 'current' }],
      // A channel node is the contracts reading's record (the driver's own owner of `code.channel`):
      // this stage's broker links end at it, so it waits for the stage that publishes it.
      optional: [{ capability: 'channel', scope: 'repository', freshness: 'current' }],
    },
    produces: OPERATIONS_STAGE_KINDS.map((kind) => ({ kind, schemaVersion: kind === 'coverage' ? 1 : 1, scope: 'file' })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planOperations(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeOperationsUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(OPERATIONS_STAGE_ID, OPERATIONS_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run fills, in the driver's area order and then in code point
 * order of the paths: a unit per file this stage reads whose blob this stage's
 * own coverage does not hold, and one per published file the commit no longer
 * holds, whose unit publishes nothing and so retracts what an earlier run wrote
 * there.
 */
async function planOperations(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const operationsRead = publishedOperationsRead(pin.id);
    const own = publishedOperationsRows(await graph.query(operationsRead), pin.id, operationsRead);
    const readBlobs = new Map<string, string>(own.map((row) => [row.file, row.blob]));
    const mine = reader.files().filter((entry) => {
      const family = operationsFamilyOf(entry.path);
      return family !== undefined && FAMILIES_READ.includes(family);
    });
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    const planned: { path: string; rank: number }[] = [];
    for (const entry of mine) {
      if (readBlobs.get(entry.path) === entry.id) continue;
      // A file whose node the snapshot has not published is no unit of this stage yet: its
      // containment edge would end at a node nothing published (decision 0033, item 15).
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      planned.push({ path: entry.path, rank: FAMILY_RANK[operationsFamilyOf(entry.path) ?? 'code'] ?? 99 });
    }
    planned.sort((left, right) => left.rank - right.rank || byCodePoint(left.path, right.path));
    for (const entry of planned) units.push({ id: fileUnitId(pin.id, entry.path), scope: `${pin.id}:${entry.path}` });
    for (const row of own) {
      // A published file the commit no longer holds: the unit publishes nothing, and the
      // publication retracts what it wrote there.
      if (present.has(row.file)) continue;
      units.push({ id: fileUnitId(pin.id, row.file), scope: `${pin.id}:${row.file}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

// ---- one unit ------------------------------------------------------------

/** One unit: the file the unit names, read at the pinned commit, and the records its bytes hold. */
async function executeOperationsUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  const source = stage.repository;
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const file = await source.file(planned.path);
  if (file === undefined || file.unread !== undefined) {
    const reason = file === undefined ? 'inaccessible' : file.unread === 'too-large' ? 'too-large' : 'unsupported';
    writeCoverage(context, source, planned.path, uncovered(planned.repository, planned.path, reason), entry.id);
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? `above the static reading cap of ${String(STATIC_FILE_BYTE_LIMIT)} bytes` : 'not a source text this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  refuseWhenCancelled(unit, context);
  const text_ = new FileText(planned.path, file.content!);
  const gaps: CoverageGap[] = [];
  if (!isUtf8(file.content!)) gaps.push({ what: `${planned.path} is not UTF-8 text`, reason: 'unsupported' });
  const family = operationsFamilyOf(planned.path) ?? 'code';
  let records: FileRecords;
  try {
    records = await recordsOfUnit(stage, planned.repository, family, text_, gaps);
  } catch (error) {
    gaps.push({ what: gapWhatOf(error, planned.path), reason: 'error' });
    records = { nodes: [], edges: [], gaps: [] };
  }
  for (const gap of records.gaps) gaps.push({ what: `${gap.path}: ${gap.reason}`, reason: 'error' });
  for (const write of draftWrites(records, planned.repository, planned.path, source, context)) context.draft.write(write);
  writeCoverage(context, source, planned.path, {
    repository: planned.repository,
    scope: planned.path,
    complete: gaps.length === 0,
    read: [planned.path],
    unread: gaps,
  }, entry.id);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(records.nodes.length)} ${records.nodes.length === 1 ? 'node' : 'nodes'}, ${String(records.edges.length)} ${records.edges.length === 1 ? 'edge' : 'edges'}, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** A coverage value for a file this stage could not read. */
function uncovered(repository: string, path: string, reason: string): CoverageValue {
  return { repository, scope: path, complete: false, read: [], unread: [{ what: `${path} at ${String(OPERATIONS_SOURCE.system)} ${OPERATIONS_SOURCE.version}`, reason: reason as CoverageGap['reason'] }] };
}

/**
 * One file's records, as this stage's reading of it gives them: the family the
 * path belongs to, the records whose span stands in the file, and the gaps it
 * could not read. The unit is what calls this; a test that compares the reading
 * against the extract driver calls it too, one file at a time.
 */
export async function operationsRecordsOfFile(stage: StaticStageContext, repository: string, path: string, file: FileText): Promise<FileRecords> {
  void repository;
  const family = operationsFamilyOf(path) ?? 'code';
  const gaps: CoverageGap[] = [];
  const records = await recordsOfUnit(stage, repository, family, file, gaps);
  return { nodes: records.nodes, edges: records.edges, gaps: [...records.gaps, ...gaps.map((gap) => ({ path, reason: gap.what }))] };
}

/** What one file's family reads: the records whose span stands in it. */
async function recordsOfUnit(stage: StaticStageContext, repository: string, family: string, file: FileText, gaps: CoverageGap[]): Promise<FileRecords> {
  const set = new RecordSet();
  switch (family) {
    case 'lockfile': {
      // A lock file's record stands in its own bytes; it stands at all only where the
      // manifest of its folder is there to resolve through, as the driver reads it.
      const manifest = await siblingManifest(stage, file.path);
      if (manifest === undefined) return recordsOf(set);
      return basenameOf(file.path) === 'package-lock.json' ? npmLockRecords(file) : goSumRecords(file);
    }
    case 'manifest': {
      const lock = await siblingLock(stage, file.path);
      const reading = basenameOf(file.path) === 'package.json'
        ? npmManifestReading(file, lock)
        : goModReading(file, lock);
      return reading.records;
    }
    case 'compose':
      return await composeRecords(file, (service, port) => publishedElsewhere(stage, file.path, `code.port:${service}/${String(port)}`), (path) => existsInGraph(stage, path));
    case 'makefile':
      return await makefileRecords(file, (path) => existsInGraph(stage, path));
    case 'workflow':
      return workflowRecords(file);
    case 'environment':
      return environmentRecords(file, await brokersInGraph(stage, repository));
    case 'asyncapi':
      return asyncapiRecords(file, await brokersInGraph(stage, repository));
    case 'document':
      return await newcomerRecords(file, await makeTargetsOf(stage, 'Makefile'), (path) => existsInGraph(stage, path));
    case 'kubernetes':
      return await k8sRecords(
        file,
        (key) => publishedElsewhere(stage, file.path, key),
        (image) => dockerfileOfService(stage, repository, image),
      );
    case 'dockerfile': {
      const membership = await serviceMembershipOf(file.path, manifestLookup(stage.repository));
      const service = membership.unit?.name ?? (file.path.slice(0, file.path.lastIndexOf('/')) || '.');
      const read = dockerfileRead(file, service);
      if (read.read === undefined) return { nodes: [], edges: [], gaps: read.gap === undefined ? [] : [read.gap] };
      const published: number[] = [];
      for (const port of read.read.exposes) {
        if (await publishedElsewhere(stage, file.path, `code.port:${service}/${String(port)}`)) published.push(port);
      }
      return dockerfileRecords(file, read.read, (port) => published.includes(port));
    }
    case 'code':
      return await codeRecords(stage, repository, file);
    default:
      return { nodes: [], edges: [], gaps: [] };
  }
}

/** The brokers the graph already holds for a repository, by the driver's own reading of each one. */
async function brokersInGraph(stage: StaticStageContext, repository: string): Promise<readonly BrokerRow[]> {
  const brokers: BrokerRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty('code.broker', 'repository', repository, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    for (const row of page.rows) {
      const held = row.properties['record'];
      const record = held !== null && typeof held === 'object' ? held as Record<string, unknown> : {};
      const source = String(record['source'] ?? '');
      const addresses = Array.isArray(record['addresses']) ? record['addresses'].map((value) => String(value)) : [];
      const key = row.properties['recordKey'];
      if (typeof key !== 'string') continue;
      brokers.push(brokerOf(key, row.label, addresses, source));
    }
    if (page.next === null) break;
    after = page.next;
  }
  return brokers.sort((left, right) => byCodePoint(left.key, right.key));
}

/** The make targets one Makefile declares, as the graph holds them: the target's name and its node's key. */
async function makeTargetsOf(stage: StaticStageContext, path: string): Promise<ReadonlyMap<string, string>> {
  const targets = new Map<string, string>();
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty('code.make-target', 'file', path, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    for (const row of page.rows) {
      const key = row.properties['recordKey'];
      if (typeof key !== 'string') continue;
      const name = key.slice(key.lastIndexOf('#') + 1);
      if (!targets.has(name)) targets.set(name, key);
    }
    if (page.next === null) return targets;
    after = page.next;
  }
}

/** The name of a path's last leg. */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** One manifest above a file, read through the static source one path at a time. */
function manifestLookup(source: StaticStageSource): (path: string) => Promise<ManifestEntry | undefined> {
  return async (path: string): Promise<ManifestEntry | undefined> => {
    const entry = await source.entry(path);
    if (entry === undefined || entry.form === 'commit') return undefined;
    if (entry.bytes !== undefined && entry.bytes > STATIC_FILE_BYTE_LIMIT) return { path, blob: entry.id };
    const file = await source.file(path);
    return { path, blob: entry.id, ...(file?.content === undefined ? {} : { bytes: file.content }) };
  };
}

/** The manifest of a lock file's own folder, where the pinned tree holds one. */
async function siblingManifest(stage: StaticStageContext, path: string): Promise<string | undefined> {
  const folder = path.slice(0, path.lastIndexOf('/'));
  const name = basenameOf(path) === 'go.sum' ? 'go.mod' : 'package.json';
  const candidate = folder === '' ? name : `${folder}/${name}`;
  return (await stage.repository.entry(candidate)) === undefined ? undefined : candidate;
}

/** The lock file of a manifest's own folder, where the pinned tree holds one: the driver's own two names. */
async function siblingLock(stage: StaticStageContext, path: string): Promise<string | undefined> {
  const folder = path.slice(0, path.lastIndexOf('/'));
  const name = basenameOf(path) === 'go.mod' ? 'go.sum' : 'package-lock.json';
  const candidate = folder === '' ? name : `${folder}/${name}`;
  return (await stage.repository.entry(candidate)) === undefined ? undefined : candidate;
}

/**
 * Whether the pinned tree holds a file, one path at a time: a recipe's reference,
 * never a listing. A text that is no repository path — a URL, an option, a JSON
 * fragment a command names — is no file of the tree, and the source is not asked
 * about it.
 */
async function existsInGraph(stage: StaticStageContext, path: string): Promise<boolean> {
  if (!isRepositoryPath(path)) return false;
  return (await stage.repository.entry(path)) !== undefined;
}

/**
 * Whether a shared node stands in the graph under a key another file published:
 * the node's own `file` property says whose unit published it, so this unit
 * either republishes the record it owns or names it without publishing again.
 */
async function publishedElsewhere(stage: StaticStageContext, path: string, key: string): Promise<boolean> {
  const rows = await stage.byKey(key, { limit: 2 });
  return rows.some((row: StaticGraphNode) => row.properties['file'] !== path);
}

/**
 * The Dockerfile of the unit an image reference names, matched by name only —
 * the driver's `builtBy` rule (`src/extract/operations/deploy.ts`): a
 * Dockerfile belongs to the unit that declares its folder, and the image's
 * last path segment must be that unit's name. The Dockerfiles are read from the
 * graph by property, one page at a time, and each one's unit is read by the
 * same path-scoped manifest chain the plan uses.
 */
async function dockerfileOfService(stage: StaticStageContext, repository: string, image: string): Promise<string | undefined> {
  const service = imageServiceName(image);
  const rows: StaticGraphNode[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty('code.dockerfile', 'repository', repository, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    if (page.next === null) break;
    after = page.next;
  }
  const paths = rows
    .map((row) => row.properties['file'])
    .filter((held): held is string => typeof held === 'string')
    .sort(byCodePoint);
  for (const path of paths) {
    const membership = await serviceMembershipOf(path, manifestLookup(stage.repository));
    const owner = membership.unit?.name ?? (path.slice(0, path.lastIndexOf('/')) || '.');
    if (owner !== service) continue;
    if ((await stage.repository.entry(path)) === undefined) return undefined;
    return path;
  }
  return undefined;
}

/**
 * One code file's records: the dependencies of its unit's manifest that its own
 * imports name, and — where a Dockerfile of its unit starts it — the process,
 * the `starts` edge and the port it listens on.
 */
async function codeRecords(stage: StaticStageContext, repository: string, file: FileText): Promise<FileRecords> {
  const set = new RecordSet();
  const membership = await serviceMembershipOf(file.path, manifestLookup(stage.repository));
  const manifestPath = membership.unit?.manifestPath;
  if (manifestPath !== undefined) {
    const manifest = await readFileText(stage, manifestPath);
    if (manifest !== undefined) {
      const declared = basenameOf(manifestPath) === 'go.mod' ? goModReading(manifest, undefined).declared : npmManifestReading(manifest, undefined).declared;
      const imports = await importSpecifiers(stage, file.path);
      usesDependencyRecords(file, manifestPath, declared, imports, set);
    }
  }
  // What the file reads from the environment, as the extract driver's environment area reads
  // it: the later links stage aggregates these per-file reads into the variables and the
  // definitions that set them (madarch-8bdc.2.4's second stage).
  for (const read of await envReadFactsOf(stage, repository, file, membership.unit?.name ?? '')) set.add(read);
  const root = membership.unit?.root;
  if (root !== undefined) {
    const dockerfilePath = root === '' ? 'Dockerfile' : `${root}/Dockerfile`;
    const dockerfile = await readFileText(stage, dockerfilePath);
    if (dockerfile !== undefined) {
      const read = dockerfileRead(dockerfile, membership.unit?.name ?? root);
      const started = read.read === undefined ? undefined : await startedProcessOf(read.read, (candidate) => existsInGraph(stage, candidate));
      if (read.read !== undefined && started !== undefined && started.mainFile === file.path) {
        const listen = await listenAddress(stage, file);
        const publishPort = listen !== undefined && !(await publishedElsewhere(stage, file.path, `code.port:${read.read.service}/${String(listen.port)}`));
        const records = processRecords({ file, dockerfile, reading: read.read, started, listen, publishPort });
        for (const node of records.nodes) set.add(node);
        for (const edge of records.edges) set.edge(edge.type, edge.from, edge.to, edge.properties, edge.span, edge.discriminator);
        for (const gap of records.gaps) set.gap(gap.path, gap.reason);
      }
    }
  }
  return recordsOf(set);
}


/** One environment read as the file's own record: the variable, the callable, the default and the place. */
async function envReadFactsOf(stage: StaticStageContext, repository: string, file: FileText, service: string): Promise<readonly NodeRecord[]> {
  const held = await envReadsInFile(stage, repository, file.path, service);
  return held.map((read) => ({
    key: `code.env-read:${repository}:${file.path}#${read.name}@${String(read.line)}`,
    kind: 'code.env-read',
    label: read.name,
    properties: {
      variable: `${read.service}/${read.name}`,
      service: read.service,
      name: read.name,
      path: read.path,
      line: read.line,
      symbol: read.symbol,
      required: read.required,
      default: read.default,
    },
    span: file.spanOfLine(read.line),
  }));
}

/**
 * The environment reads of one code file, read from the facts the code-facts stage
 * published and the library effects the library reader proves for it: the file's
 * expressions, bindings, calls and callables by property, and no other file's
 * answer. A file whose language the reader does not follow reads nothing.
 */
async function envReadsInFile(stage: StaticStageContext, repository: string, path: string, service: string): Promise<readonly EnvRead[]> {
  if (service === '') return [];
  const language = path.endsWith('.go') ? 'go' as const : 'typescript' as const;
  const [expressions, bindings, calls, callables, effects] = await Promise.all([
    factsOf(stage, 'code.expression', path),
    factsOf(stage, 'code.binding', path),
    factsOf(stage, 'code.call', path),
    factsOf(stage, 'code.callable', path),
    libraryEffectsOf(stage, repository, path),
  ]);
  return envReadsOf({
    path,
    language,
    service,
    expressions: expressions as unknown as readonly EnvExpression[],
    bindings: bindings as unknown as readonly EnvBinding[],
    calls: calls as unknown as readonly EnvCall[],
    callables: callables.filter((held) => held['callable'] === true).map((held) => ({
      key: String(held['symbolKey']),
      name: String(held['name']),
      qualifiedName: String(held['qualifiedName']),
      span: held['span'] as EnvSpan,
      ...(held['bodySpan'] === undefined ? {} : { bodySpan: held['bodySpan'] as EnvSpan }),
    })),
    effects: effects.effects,
  });
}

/** One file of the pinned tree, as text. */
async function readFileText(stage: StaticStageContext, path: string): Promise<FileText | undefined> {
  const file = await stage.repository.file(path);
  return file?.content === undefined ? undefined : new FileText(path, file.content);
}

/** The import specifiers one code file's own facts hold, each with the first line it stands on. */
async function importSpecifiers(stage: StaticStageContext, path: string): Promise<readonly { readonly specifier: string; readonly line: number }[]> {
  const rows: StaticGraphNode[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty('code.binding', 'file', path, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    if (page.next === null) break;
    after = page.next;
  }
  const found: { specifier: string; line: number }[] = [];
  for (const row of rows) {
    if (row.properties['kind'] !== 'import') continue;
    const specifier = row.properties['specifier'];
    const span = row.properties['span'] as RecordSpan | undefined;
    if (typeof specifier !== 'string' || span === undefined) continue;
    found.push({ specifier, line: span.lineStart });
  }
  return found.sort((left, right) => left.line - right.line || byCodePoint(left.specifier, right.specifier));
}

/**
 * The listen address one code file declares, read from its own facts in the
 * graph: a `listen`/`ListenAndServe` call's argument, the literal it names or
 * the constant its binding holds — the driver's `listenPort` rule
 * (`src/extract/operations/deploy.ts`), over the facts the code-facts stage
 * published rather than over one repository-wide object.
 */
async function listenAddress(stage: StaticStageContext, file: FileText): Promise<{ readonly port: number; readonly addr: string; readonly line: number } | undefined> {
  const expressions = await factsOf(stage, 'code.expression', file.path);
  const bindings = await factsOf(stage, 'code.binding', file.path);
  const calls = await factsOf(stage, 'code.call', file.path);
  const byId = new Map(expressions.map((expression) => [String(expression['id']), expression]));
  const unwrap = (id: unknown): Readonly<Record<string, unknown>> | undefined => {
    let held = typeof id === 'string' ? byId.get(id) : undefined;
    const seen = new Set<string>();
    while (held !== undefined && held['syntaxKind'] === 'expression_list' && !seen.has(String(held['id']))) {
      seen.add(String(held['id']));
      const children = held['children'];
      held = Array.isArray(children) && typeof children[0] === 'string' ? byId.get(children[0]) : undefined;
    }
    return held;
  };
  const address = (value: string): { readonly port: number; readonly addr: string } | undefined => {
    const colon = value.lastIndexOf(':');
    const digits = (colon < 0 ? value : value.slice(colon + 1)).trim();
    if (digits === '' || [...digits].some((character) => character < '0' || character > '9')) return undefined;
    const port = Number.parseInt(digits, 10);
    return Number.isFinite(port) ? { port, addr: value } : undefined;
  };
  const lineOf = (expression: Readonly<Record<string, unknown>>): number => {
    const span = expression['span'] as RecordSpan | undefined;
    return span?.lineStart ?? 1;
  };
  const addressOf = (id: unknown): { readonly port: number; readonly addr: string; readonly line: number } | undefined => {
    const held = unwrap(id);
    if (held === undefined) return undefined;
    const literal = held['literal'] as { readonly kind?: unknown; readonly value?: unknown } | undefined;
    if (literal !== undefined && (literal.kind === 'string' || literal.kind === 'number')) {
      const stated = address(String(literal.value));
      if (stated !== undefined) return { ...stated, line: lineOf(held) };
    }
    const bindingId = held['bindingId'];
    const binding = typeof bindingId === 'string' ? bindings.find((entry) => entry['id'] === bindingId) : undefined;
    const initializer = binding?.['initializer'];
    if (initializer === undefined) return undefined;
    const initial = unwrap(initializer);
    const initialLiteral = initial?.['literal'] as { readonly kind?: unknown; readonly value?: unknown } | undefined;
    if (initial === undefined || initialLiteral === undefined || (initialLiteral.kind !== 'string' && initialLiteral.kind !== 'number')) return undefined;
    const stated = address(String(initialLiteral.value));
    return stated === undefined ? undefined : { ...stated, line: lineOf(held) };
  };
  for (const call of [...calls].sort((left, right) => lineOf(left) - lineOf(right))) {
    const callee = unwrap(call['callee']);
    if (callee?.['member'] !== 'listen' && callee?.['member'] !== 'ListenAndServe') continue;
    const args = call['arguments'];
    const found = addressOf(Array.isArray(args) ? args[0] : undefined);
    if (found !== undefined) return found;
  }
  // A Go file's listen address constant, which the call's own argument names.
  for (const binding of bindings) {
    if (binding['name'] !== 'listenAddr' || binding['initializer'] === undefined) continue;
    const found = addressOf(binding['initializer']);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every node of one kind the graph holds for one file, page by page: the file's own facts, bounded. */
async function factsOf(stage: StaticStageContext, kind: string, path: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const rows: Readonly<Record<string, unknown>>[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty(kind, 'file', path, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    for (const row of page.rows) rows.push(row.properties);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** Whether the bytes are UTF-8 text: a fatal decode refuses what it cannot read. */
function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** What one unreadable file says in its coverage: the reader's own words, or the path and the failure where it named none. */
function gapWhatOf(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${path}:`) ? message : `${path}:1: ${message}`;
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the operations stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/operations.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/operations.ts)`);
  }
}

// ---- the draft -----------------------------------------------------------

/** One node record's graph properties: the record verbatim, under the metadata every static stage's nodes carry. */
function nodePropertiesOf(node: { readonly key: string; readonly kind: string; readonly properties: Readonly<Record<string, unknown>>; readonly span?: RecordSpan }, repository: string, commit: string, path: string) {
  const file = node.span?.path ?? path;
  return {
    recordKey: node.key,
    factKind: node.kind.slice('code.'.length),
    repository,
    file,
    ...(node.span === undefined ? {} : { span: node.span }),
    record: node.properties,
    provenance: { source: OPERATIONS_SOURCE, repository: { id: repository, commit }, place: { file, range: rangeOf(node.span) } },
  };
}

/** The lines a record's provenance cites: the record's own span, or the whole file where it cites none. */
function rangeOf(span: RecordSpan | undefined) {
  return { startLine: span?.lineStart ?? 1, startColumn: 0, endLine: span?.lineEnd ?? 1, endColumn: 0 };
}

/** One edge record's graph properties: the record verbatim, under the metadata every static stage's edges carry. */
function edgePropertiesOf(edge: { readonly type: string; readonly properties: Readonly<Record<string, unknown>>; readonly span?: RecordSpan; readonly discriminator: string }, repository: string, path: string) {
  return {
    factKind: edge.type.slice('code.'.length),
    repository,
    file: edge.span?.path ?? path,
    ...(edge.span === undefined ? {} : { span: edge.span }),
    ...(edge.discriminator === '' ? {} : { discriminator: edge.discriminator }),
    record: edge.properties,
  };
}

/** One end of an edge, as the graph names it: a file by the node stage 0 published, every other record by its key. */
function endOf(key: string, repository: string): { readonly key: string } {
  return key.startsWith('code.file:') ? { key: fileFactIdOf(repository, key.slice('code.file:'.length)) } : { key };
}

/** What one unit's draft writes: its nodes, its edges and the file's own `code.contains` edges. */
function draftWrites(records: FileRecords, repository: string, path: string, source: StaticStageSource, context: StageContext): readonly StageDraftWrite[] {
  void context;
  const writes: StageDraftWrite[] = [];
  const evidence = evidenceAtPlace(source, path);
  for (const node of records.nodes) {
    writes.push({
      kind: 'node',
      evidence,
      value: {
        key: node.key,
        kind: node.kind,
        label: node.label,
        properties: nodePropertiesOf(node, repository, source.commit, path),
      },
    });
  }
  for (const edge of records.edges) {
    writes.push({
      kind: 'edge',
      evidence,
      value: {
        relation: edge.type,
        from: endOf(edge.from, repository),
        to: endOf(edge.to, repository),
        properties: edgePropertiesOf(edge, repository, path),
      },
    });
  }
  // What a file holds, hung from the file's node, for every record whose span stands in it: the
  // driver's own closing pass over the records it made (madarch-m38l.16).
  for (const node of records.nodes) {
    // The environment reads are this stage's own bookkeeping, read by the links stage and never
    // a record of the reading: no file holds them (madarch-8bdc.2.4's second stage).
    if (node.kind === 'code.env-read') continue;
    if (node.span === undefined || node.span.path !== path) continue;
    writes.push({
      kind: 'edge',
      evidence,
      value: {
        relation: 'code.contains',
        from: { key: fileFactIdOf(repository, path) },
        to: { key: node.key },
        properties: { factKind: 'contains', repository, file: path, span: node.span, record: {} },
      },
    });
  }
  return writes;
}

/** One file's coverage: what was read, and every place this stage could not read, with the blob the bytes stood under. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: OPERATIONS_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    // The blob the plan compares against the pinned commit stands on the coverage node.
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob } } }
      : write);
  }
}

// ---- reading a read's rows ------------------------------------------------

/**
 * The plan's own read, read: each row is one file this stage read and the blob
 * its bytes stood under. A row naming another kind, a file that is no
 * repository path, a blob that is no blob id, or a key this read does not
 * define is refused, naming the read, the row and the field.
 */
export function publishedOperationsRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedOperationsRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'what a file\'s operations records read');
    unknownKeys(held, OPERATIONS_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || file === '') {
      throw refuseRow(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a coverage stands for a file of the repository`);
    }
    const blob = held['blob'];
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) {
      throw refuseRow(read, index, repository, `its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    }
    return { kind: 'coverage', file, blob };
  });
}
