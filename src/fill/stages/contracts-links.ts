/**
 * The links a repository's code makes to the contracts it serves, as a static
 * stage (decision 0033, items 5, 7, 14 and 15; madarch-8bdc.2.4). One unit per
 * source file publishes the `code.serves` edges its own routes and its gRPC
 * servers state: the route that serves an OpenAPI operation, and the file and
 * the handler that serve a proto method.
 *
 * **Why this stage stands after `contracts` and `contracts-routes`.** A serving
 * link joins a route one file registers to an operation a contract document
 * declares; neither the route's file nor the document's file can see the other
 * when its own stage runs, so the link is read in a stage declared after both
 * (decision 0033, item 5; the coordinator's decision 1).
 *
 * **What it publishes.** One `code.serves` per route that serves an operation,
 * with the operation's service and the route's span; and, for a gRPC server, a
 * file-level `code.serves` (`summary: true`) beside the handler-level one, as
 * the driver's own `interaction` rule emits them.
 *
 * **The matching rule is the driver's own.** An operation's paths are its
 * servers' paths joined with the operation's template (the operation's own
 * template when no server names a path); a route matches when its method is the
 * operation's and its path template matches segment by segment, a parameter
 * segment (`{id}`, `:id`, `${id}`) matching any parameter segment. The route's
 * service scopes the match. On this branch the routes of one service are read
 * by the service's own property, so a template duplicated across services is
 * compared within the service it serves.
 *
 * **A refill writes nothing.** The plan compares each file's blob with this
 * stage's own coverage.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { isRepositoryPath } from '../facts.js';
import { FACT_KINDS, makeNodeFact, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { readTsFile, joinPath, type TsFileFacts } from '../../extract/contracts/ts-code.js';
import { inferOutboxPublications } from '../../extract/contracts/outbox.js';
import { fileCodeViewOf } from './contracts-facts.js';
import { readGoFile, resolveGoStarts, type GoFileFacts } from '../../extract/contracts/go-code.js';
import {
  EDGE_BELONGS_TO, EDGE_CONTAINS, KIND_ENTRY_POINT, REL_CONSUMES, REL_PUBLISHES, REL_SERVES, channelKey, entryPointKey,
} from '../../extract/contracts/schema.js';
import type { SourceSpan } from '../../extract/records.js';
import { evidenceAtPlace } from './draft.js';
import { readSyntaxTree } from './syntax-extract.js';
import type { StaticGraphNode, StaticStageContext, StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
const CONTRACTS_LINKS_STAGE_ID = 'contracts-links';

/** The stage's own version, bumped when what it writes or plans changes. */
const CONTRACTS_LINKS_STAGE_VERSION = 3;

/** The fact kinds the stage produces, in code point order. */
const CONTRACTS_LINKS_STAGE_KINDS: readonly string[] = ['belongs-to', 'consumes', 'contains', 'coverage', 'entry-point', 'publishes', 'serves', 'starts'];

/** The reader every fact of this stage cites. */
export const CONTRACTS_LINKS_SOURCE_SYSTEM = 'madarch-contracts-links';

/** The reader every fact of this stage cites. */
const CONTRACTS_LINKS_SOURCE: FactSource = { system: CONTRACTS_LINKS_SOURCE_SYSTEM, version: '1' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_CONTRACTS_LINKS_READ = 'stage-contracts-links-published';

/** The read of one repository's published links: one row per file this stage read. */
function publishedContractsLinksRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_CONTRACTS_LINKS_READ, repository });
}

/** One row of that read: one file this stage read, at the blob its bytes stood under. */
interface PublishedContractsLinksRow {
  readonly kind: 'coverage';
  readonly path: string;
  readonly blob?: string;
}

/** The keys a row of that read holds, and no others. */
const CONTRACTS_LINKS_ROW_FIELDS: readonly string[] = ['blob', 'kind', 'path', 'repository'];

/** The stage, built over the source that holds the run's pins. */
export function createContractsLinksStage(sources: SnapshotSource): FillStage {
  return {
    id: CONTRACTS_LINKS_STAGE_ID,
    version: CONTRACTS_LINKS_STAGE_VERSION,
    staticReading: true,
    consumes: {
      required: [{ capability: 'file', scope: 'repository', freshness: 'current' }],
      optional: [
        { capability: 'route', scope: 'repository', freshness: 'current' },
        { capability: 'operation', scope: 'repository', freshness: 'current' },
        { capability: 'callable', scope: 'repository', freshness: 'current' },
        { capability: 'service-unit', scope: 'repository', freshness: 'current' },
        { capability: 'symbol', scope: 'repository', freshness: 'current' },
        // An entry point's `code.starts` ends at the process the operations reading publishes, and
        // its `code.belongs-to` at the service that reading owns; ordering the stage after the
        // operations stage is the graph's own answer (decision 0033, item 5).
        { capability: 'process', scope: 'repository', freshness: 'current' },
        { capability: 'service', scope: 'repository', freshness: 'current' },
        // The Go package a `main` file's `starts` resolves through: its per-file facts.
        { capability: 'go-package', scope: 'repository', freshness: 'current' },
        // The Kafka sites and consumer names one file states, and the channels they name: a consume
        // link joins a site to a channel another file declares (madarch-8bdc.2.4).
        { capability: 'kafka-site', scope: 'repository', freshness: 'current' },
        { capability: 'go-consumer', scope: 'repository', freshness: 'current' },
        { capability: 'channel', scope: 'repository', freshness: 'current' },
        // The publication sites one file states and the constants and unions a channel's edge names.
        { capability: 'publisher-site', scope: 'repository', freshness: 'current' },
        { capability: 'file-names', scope: 'repository', freshness: 'current' },
      ],
    },
    produces: [
      { kind: 'belongs-to', schemaVersion: 1, scope: 'file' },
      { kind: 'consumes', schemaVersion: 1, scope: 'file' },
      { kind: 'publishes', schemaVersion: 1, scope: 'file' },
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'entry-point', schemaVersion: 1, scope: 'file' },
      { kind: 'serves', schemaVersion: 1, scope: 'file' },
      { kind: 'starts', schemaVersion: 1, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planContractsLinks(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeContractsLinksUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(CONTRACTS_LINKS_STAGE_ID, CONTRACTS_LINKS_STAGE_KINDS, draft),
  };
}

/** Whether a path is a file this stage reads: the extract driver's own source rule. */
function isLinkPath(path: string): boolean {
  return (path.endsWith('.ts') || path.endsWith('.go'))
    && !path.endsWith('.d.ts')
    && !/(^|\/)(test|tests|__tests__)\//.test(path)
    && !/\.(test|spec)\.[tj]s$/.test(path)
    && !path.endsWith('_test.go');
}

// ---- planning ------------------------------------------------------------

/** The units one run fills: a unit per source file this stage's coverage does not name at the pinned blob, and one per published file the commit no longer holds. */
async function planContractsLinks(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const ownRead = publishedContractsLinksRead(pin.id);
    const own = publishedContractsLinksRows(await graph.query(ownRead), pin.id, ownRead);
    const readBlobs = new Map<string, string | undefined>(own.map((row) => [row.path, row.blob]));
    const mine = reader.files().filter((entry) => isLinkPath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    for (const entry of mine) {
      if (readBlobs.get(entry.path) === entry.id) continue;
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), scope: `${pin.id}:${entry.path}` });
    }
    for (const row of own) {
      if (present.has(row.path)) continue;
      units.push({ id: fileUnitId(pin.id, row.path), scope: `${pin.id}:${row.path}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** The plan's own read, read. */
function publishedContractsLinksRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedContractsLinksRow[] {
  return rows.map((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind and its path`);
    const held = row as Record<string, unknown>;
    for (const key of Object.keys(held).sort(byCodePoint)) {
      if (!CONTRACTS_LINKS_ROW_FIELDS.includes(key)) throw refuse(`it holds ${JSON.stringify(key)}, and a row holds ${CONTRACTS_LINKS_ROW_FIELDS.join(', ')}`);
    }
    if (held['kind'] !== 'coverage') throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" rows`);
    const path = held['path'];
    if (typeof path !== 'string' || !isRepositoryPath(path) || !isLinkPath(path)) throw refuse(`its path ${JSON.stringify(path)} is no source file of this reading`);
    const blob = held['blob'];
    if (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob))) throw refuse(`its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    return { kind: 'coverage', path, ...(blob === undefined ? {} : { blob }) };
  });
}

// ---- one unit ------------------------------------------------------------

/** One operation the serving rule matches a route against, as the contract stage published it. */
interface OperationRow {
  readonly key: string;
  readonly rpc?: string;
  readonly method?: string;
  readonly path?: string;
  readonly servers: readonly string[];
  readonly service?: string;
}

/** One route the serving rule matches, as the routes stage published it. */
interface RouteRow {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly service?: string;
  readonly span?: SourceSpan;
}

/** One `code.serves` edge a unit writes. */
interface ServeEdge {
  readonly from: string;
  readonly to: string;
  readonly properties: Record<string, unknown>;
  readonly span?: SourceSpan;
}

/** One unit: the source file the unit names, its routes and gRPC sites, and the operations they serve. */
async function executeContractsLinksUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  refuseWhenCancelled(unit, context);
  const source = stage.repository;
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const file = await source.file(planned.path);
  if (file === undefined || file.unread !== undefined) {
    const reason = file === undefined ? 'inaccessible' : file.unread === 'too-large' ? 'too-large' : 'unsupported';
    writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: false, read: [], unread: [{ what: `${planned.path} at ${String(CONTRACTS_LINKS_SOURCE.system)} ${CONTRACTS_LINKS_SOURCE.version}`, reason }] }, entry.id);
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? 'above the static reading cap' : 'not a source file this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  const isGo = planned.path.endsWith('.go');
  const read = await readSyntaxTree(planned.path, file.content!, (tree) => isGo ? readGoFile(planned.path, tree.root) : readTsFile(planned.path, tree.root));
  if (!read.read) {
    const gaps: CoverageGap[] = read.unread.map((gap) => ({ what: `${planned.path}:1: ${gap.what}`, reason: gap.reason }));
    writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: false, read: [], unread: gaps }, entry.id);
    context.progress(`${planned.path} of ${planned.repository} could not be read as ${isGo ? 'Go' : 'TypeScript'}: the file is published as a coverage gap`, 1);
    return { outcome: 'draft' };
  }
  const service = await serviceOf(stage, planned.path);
  const operations = await operationRows(stage, planned.repository);
  const edges: ServeEdge[] = [];
  const serviceRoutes = await routeRows(stage, service, planned.path, false);
  const ownRoutes = serviceRoutes.filter((route) => route.span?.path === planned.path);
  for (const operation of operations) {
    // The driver's own rule: the operation's one serving route in its service. A service with two
    // matching routes serves nothing it can name, and no edge is claimed.
    if (operation.method === undefined || operation.service !== service) continue;
    const candidates = serviceRoutes.filter((route) => route.method === operation.method && operationPaths(operation).some((path) => pathMatches(route.path, path)));
    if (candidates.length !== 1) continue;
    const route = candidates[0]!;
    if (!ownRoutes.some((own) => own.key === route.key)) continue;
    edges.push({ from: route.key, to: operation.key, properties: { service: route.service ?? '' }, ...(route.span === undefined ? {} : { span: route.span }) });
  }
  if (!isGo) {
    const facts = read.value as TsFileFacts;
    edges.push(...await grpcServes(stage, planned.path, facts, operations, fileFactIdOf(planned.repository, planned.path)));
  }
  const evidence = evidenceAtPlace(source, planned.path);
  for (const edge of edges) {
    context.draft.write(edgeWrite(REL_SERVES, edge.from, edge.to, { span: edge.span, discriminator: '' }, inputOf(planned.repository, evidence), edge.properties));
  }
  const entryRecords = await entryWrites({
    stage,
    path: planned.path,
    repository: planned.repository,
    evidence,
    service,
    fileKey: fileFactIdOf(planned.repository, planned.path),
    bytes: file.content!,
    ts: isGo ? undefined : read.value as TsFileFacts,
    go: isGo ? read.value as GoFileFacts : undefined,
  });
  for (const write of entryRecords) context.draft.write(write);
  const consumeRecords = await consumeWrites(stage, planned.repository, planned.path, evidence, fileFactIdOf(planned.repository, planned.path));
  for (const write of consumeRecords) context.draft.write(write);
  const publishRecords: readonly StageDraftWrite[] = [];
  // const publishRecords = await publishWrites(stage, source, planned.repository, planned.path, evidence, fileFactIdOf(planned.repository, planned.path));
  // for (const write of publishRecords) context.draft.write(write);
  writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: true, read: [planned.path], unread: [] }, entry.id);
  context.progress(`read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(edges.length)} ${edges.length === 1 ? 'serving link' : 'serving links'}, ${String(entryRecords.length)} ${entryRecords.length === 1 ? 'entry record' : 'entry records'}, ${String(consumeRecords.length)} consume ${consumeRecords.length === 1 ? 'edge' : 'edges'}, ${String(publishRecords.length)} publish ${publishRecords.length === 1 ? 'edge' : 'edges'}`, 1);
  return { outcome: 'draft' };
}

// ---- the entry point a file states ---------------------------------------

/** One started unit of an entry point, as the driver's own reader names it. */
interface StartedUnit {
  readonly kind: string;
  readonly symbol: string;
  readonly path?: string;
  readonly port?: string;
}

/**
 * The entry point a file states, its `code.starts` edges and its `code.belongs-to` edge, as the
 * driver's contracts reading publishes them: a Go `package main` whose `main` starts the process,
 * and a TypeScript file the code facts prove an entry (madarch-8bdc.2.4). A `starts` edge ends at
 * the file, at the process the operations reading published, or at the file a started job stands
 * in; an end no node carries is named in the unit's progress and claims no edge, because an edge
 * joins nodes that exist (decision 0028).
 */
async function entryWrites(input: {
  readonly stage: StaticStageContext;
  readonly path: string;
  readonly repository: string;
  readonly evidence: string;
  readonly service: string | undefined;
  readonly fileKey: string;
  readonly bytes: Uint8Array;
  readonly ts: TsFileFacts | undefined;
  readonly go: GoFileFacts | undefined;
}): Promise<readonly StageDraftWrite[]> {
  const whole = wholeFileSpan(input.path, input.bytes);
  const writes: StageDraftWrite[] = [];
  let symbol: string | undefined;
  let started: readonly StartedUnit[] = [];
  if (input.go !== undefined) {
    if (!input.go.entryPoint) return [];
    symbol = 'main';
    started = await goStarts(input.stage, input.repository, input.path, input.go.rawStarts);
  } else if (input.ts?.entry !== undefined) {
    symbol = input.ts.entry.symbol;
    started = input.ts.started.map((unit) => ({
      kind: unit.kind,
      symbol: unit.symbol,
      ...(unit.path === undefined ? {} : { path: unit.path }),
      ...(unit.port === undefined ? {} : { port: unit.port }),
    }));
  }
  if (symbol === undefined) return [];
  const key = entryPointKey(input.path, symbol);
  const language = input.go === undefined ? 'typescript' : 'go';
  const label = input.go === undefined
    ? `${input.service ?? 'service'} · ${input.path} · ${symbol}`
    : `${input.service ?? 'service'} · ${input.path}`;
  writes.push(nodeWrite(key, KIND_ENTRY_POINT, label, {
    language,
    service: input.service ?? '',
    file: input.path,
    symbol,
    starts: started.map((unit) => ({
      kind: unit.kind,
      symbol: unit.symbol,
      ...(unit.path === undefined ? {} : { path: unit.path }),
      ...(unit.port === undefined ? {} : { port: unit.port }),
    })),
  }, whole, input.repository, input.evidence, 'entry-point'));
  writes.push(recordEdge(EDGE_CONTAINS, input.fileKey, key, {}, whole, input.evidence, input.repository));
  writes.push(recordEdge('code.starts', key, input.fileKey, { kind: 'entry-file' }, whole, input.evidence, input.repository));
  if (input.service !== undefined && await nodeExists(input.stage, 'code.service', `code.service:${input.service}`)) {
    writes.push(recordEdge(EDGE_BELONGS_TO, key, `code.service:${input.service}`, {}, whole, input.evidence, input.repository));
  }
  const process = processKeyOf(input.path);
  if (process !== undefined && await nodeExists(input.stage, 'code.process', process)) {
    writes.push(recordEdge('code.starts', key, process, { kind: 'process' }, whole, input.evidence, input.repository, 'process'));
  }
  for (const unit of started) {
    if (unit.path === undefined) continue;
    const startedFile = fileFactIdOf(input.repository, unit.path);
    // A started file the snapshot published no node for claims no edge: an edge joins nodes that exist.
    if (!await nodeExists(input.stage, 'code.file', startedFile)) continue;
    writes.push(recordEdge('code.starts', key, startedFile, { kind: unit.kind, symbol: unit.symbol, ...(unit.port === undefined ? {} : { port: unit.port }) }, whole, input.evidence, input.repository, `${unit.kind}:${unit.symbol}`));
  }
  return writes;
}

/**
 * The units a Go `main` starts, by the driver's own package rule (`resolveGoStarts`): the package's
 * constants, server addresses and functions are the per-file `code.go-package` facts of the folder,
 * in code point order of their paths, which is the order the driver's walk holds them in.
 */
async function goStarts(stage: StaticStageContext, repository: string, path: string, rawStarts: GoFileFacts['rawStarts']): Promise<readonly StartedUnit[]> {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const rows = (await allPages((page) => stage.byProperty('code.go-package', 'folder', folder, page)))
    .filter((row) => typeof row.properties['file'] === 'string' && String(row.properties['repository'] ?? repository) === repository)
    .sort((left, right) => byCodePoint(String(left.properties['file']), String(right.properties['file'])));
  const files = rows.map((row) => ({
    path: String(row.properties['file']),
    go: {
      consts: pairsOf(row.properties['consts']),
      serverAddrs: pairsOf(row.properties['serverAddrs']),
      functions: arrayOf(row.properties['functions']),
      rawStarts,
    },
  }));
  if (rows.length === 0) {
    return resolveGoStarts([{ path, go: { consts: new Map(), serverAddrs: new Map(), functions: [], rawStarts } }], path);
  }
  return resolveGoStarts(files, path);
}

/** A pair list a fact holds (`[[name, value], ...]`), as the map whose order the list keeps. */
function pairsOf(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
    out.set(entry[0], entry[1]);
  }
  return out;
}

/** Whether the graph holds one node under a key. */
async function nodeExists(stage: StaticStageContext, kind: string, key: string): Promise<boolean> {
  const rows = await allPages((page) => stage.byProperty(kind, 'recordKey', key, page));
  return rows.length > 0;
}

/** The process a file's entry point starts, keyed as the operations reading keys it. */
function processKeyOf(path: string): string | undefined {
  if (path.endsWith('/main.go')) {
    const folder = path.slice(0, path.lastIndexOf('/'));
    return folder === '' ? undefined : `code.process:${folder}`;
  }
  return /\.[cm]?[jt]sx?$/.test(path) ? `code.process:${path}` : undefined;
}

/** The operations one run published, read by repository. */
async function operationRows(stage: StaticStageContext, repository: string): Promise<readonly OperationRow[]> {
  const nodes = await allPages((page) => stage.byProperty('code.operation', 'repository', repository, page));
  return nodes.map((node) => ({
    key: recordKeyOf(node),
    ...(node.properties['rpc'] === undefined ? {} : { rpc: String(node.properties['rpc']) }),
    ...(typeof node.properties['method'] === 'string' ? { method: node.properties['method'] as string } : {}),
    ...(typeof node.properties['path'] === 'string' ? { path: node.properties['path'] as string } : {}),
    servers: arrayOf(node.properties['servers']),
    ...(typeof node.properties['service'] === 'string' ? { service: node.properties['service'] as string } : {}),
  }));
}

/** The routes a serving link is decided among: the unit's own file's, or — when the file belongs to a service — the service's. */
async function routeRows(stage: StaticStageContext, service: string | undefined, path: string, own: boolean): Promise<readonly RouteRow[]> {
  const nodes = service === undefined || own
    ? await allPages((page) => stage.byProperty('code.route', 'file', path, page))
    : await allPages((page) => stage.byProperty('code.route', 'service', service, page));
  return nodes.map((node) => ({
    key: recordKeyOf(node),
    method: String(node.properties['method'] ?? ''),
    path: String(node.properties['path'] ?? ''),
    ...(typeof node.properties['service'] === 'string' ? { service: node.properties['service'] as string } : {}),
    ...(spanOfNode(node) === undefined ? {} : { span: spanOfNode(node) }),
  }));
}

/** The paths an operation's servers name: each server's path joined with the operation's template. */
function operationPaths(operation: OperationRow): readonly string[] {
  if (operation.path === undefined) return [];
  const paths = operation.servers.flatMap((server) => {
    try {
      return [joinPath(new URL(server, 'http://relative.invalid').pathname, operation.path!)];
    } catch {
      return [];
    }
  });
  return paths.length === 0 ? [operation.path] : paths;
}

/** Whether a route's template matches an operation's path: segment by segment, a parameter matching a parameter. */
function pathMatches(candidate: string, template: string): boolean {
  const left = candidate.split('?')[0]!.split('/');
  const right = template.split('?')[0]!.split('/');
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    const wild = (segment: string): boolean => segment.startsWith('{') || segment.startsWith(':') || segment.startsWith('${') || segment === '*' || segment === '{}';
    if (wild(a) && wild(b)) continue;
    return false;
  }
  return true;
}

/** The gRPC servers a TypeScript file starts, as file-level and handler-level serving links. */
async function grpcServes(stage: StaticStageContext, path: string, facts: TsFileFacts, operations: readonly OperationRow[], fileKey: string): Promise<readonly ServeEdge[]> {
  if (facts.protoRel === undefined) return [];
  const protoPath = normalizePath(`${folderOf(path)}/${facts.protoRel}`);
  const rpcs = operations.filter((operation) => operation.key.startsWith(`code.operation:${protoPath}#`));
  const callables = await allPages((page) => stage.byProperty('code.callable', 'file', path, page));
  const edges: ServeEdge[] = [];
  for (const site of facts.grpcSites) {
    if (site.kind !== 'serve') continue;
    const match = rpcs.find((rpc) => rpc.rpc !== undefined && rpc.rpc.toLowerCase() === site.rpc.toLowerCase());
    if (match === undefined) continue;
    const properties = { handler: site.fn !== undefined ? `${site.fn}.${site.rpc}` : site.rpc };
    edges.push({ from: fileKey, to: match.key, properties: { ...properties, summary: true }, span: site.span });
    const handler = site.handlerSpan === undefined ? undefined : callables.filter((node) => {
      const at = spanOfNode(node);
      return at !== undefined && at.byteStart === site.handlerSpan!.byteStart && at.byteEnd === site.handlerSpan!.byteEnd;
    });
    if (handler !== undefined && handler.length === 1) edges.push({ from: recordKeyOf(handler[0]!), to: match.key, properties, span: site.span });
  }
  return edges;
}

/** The folder of a repository path, empty at the root. */
function folderOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** A path with `.` and `..` legs resolved. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

// ---- the channel a file's code consumes -----------------------------------

/** One read of a consumer site, with the callable the site stands in where the file proves one. */
interface ConsumerRead {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly enclosing?: string;
}

/** One Go file's consumer names, as the contracts-code stage published them. */
interface GoConsumerRow {
  readonly file: string;
  readonly service?: string;
  readonly methods: readonly string[];
  readonly interfaceMethods: readonly string[];
  readonly switchCases: ReadonlyMap<string, readonly string[]>;
  readonly statusComparisons: readonly string[];
  readonly calledMethods: ReadonlyMap<string, readonly string[]>;
  readonly unconditionalCommit: boolean;
}

/**
 * The consume links one file's Kafka sites state, as the driver's own rule makes them: a site ends
 * at the channel another file declares, once at the file and once at the callable the read stands
 * in; a site with no proved read is the file's configured subscription. The handler a consumer
 * delegates to is read from the consumer names its service's files publish (madarch-8bdc.2.4).
 */
async function consumeWrites(stage: StaticStageContext, repository: string, path: string, evidence: string, fileKey: string): Promise<readonly StageDraftWrite[]> {
  const sites = (await allPages((page) => stage.byProperty('code.kafka-site', 'file', path, page)))
    .filter((node) => node.properties['repository'] === repository && node.properties['siteKind'] === 'consume');
  if (sites.length === 0) return [];
  const rows = (await allPages((page) => stage.byProperty('code.go-consumer', 'repository', repository, page))).map(consumerRowOf).filter((row): row is GoConsumerRow => row !== undefined);
  const own = rows.find((row) => row.file === path);
  const writes: StageDraftWrite[] = [];
  const place = inputOf(repository, evidence);
  for (const site of sites) {
    const channel = site.properties['channel'];
    if (typeof channel !== 'string') continue;
    const declared = (await stage.byKey(channelKey(channel), { limit: 2 })).filter((node) => node.kind === 'code.channel');
    if (declared.length !== 1) continue;
    const properties: Record<string, unknown> = { topic: channel };
    const group = site.properties['group'];
    if (typeof group === 'string') properties['group'] = group;
    if (own !== undefined) {
      Object.assign(properties, handlerOf(rows, own));
      if (own.unconditionalCommit) properties['offsetCommit'] = 'unconditional';
    }
    const reads = readSpans(site.properties['reads']);
    if (reads.length > 0) {
      for (const read of reads) {
        const span: SourceSpan = { path: read.path, byteStart: read.byteStart, byteEnd: read.byteEnd, lineStart: read.lineStart, lineEnd: read.lineEnd };
        writes.push(edgeWrite(REL_CONSUMES, fileKey, channelKey(channel), { span, discriminator: String(span.byteStart) }, place, { ...properties, summary: true }));
        if (read.enclosing !== undefined) writes.push(edgeWrite(REL_CONSUMES, read.enclosing, channelKey(channel), { span, discriminator: String(span.byteStart) }, place, properties));
      }
      continue;
    }
    const at = spanIn(site.properties['span']);
    writes.push(edgeWrite(REL_CONSUMES, fileKey, channelKey(channel), { span: at, discriminator: '' }, place, { ...properties, summary: true, configured: true }));
  }
  return writes;
}

/** One consumer row's properties, or none where the node is not one of this reading's. */
function consumerRowOf(node: StaticGraphNode): GoConsumerRow | undefined {
  const file = node.properties['file'];
  if (typeof file !== 'string') return undefined;
  return {
    file,
    ...(typeof node.properties['service'] === 'string' ? { service: node.properties['service'] as string } : {}),
    methods: arrayOf(node.properties['methods']),
    interfaceMethods: arrayOf(node.properties['interfaceMethods']),
    switchCases: mapOfLists(node.properties['switchCases']),
    statusComparisons: arrayOf(node.properties['statusComparisons']),
    calledMethods: mapOfLists(node.properties['calledMethods']),
    unconditionalCommit: node.properties['unconditionalCommit'] === true,
  };
}

/** The reads a site fact holds, each with the callable the file proved for it. */
function readSpans(value: unknown): readonly ConsumerRead[] {
  if (!Array.isArray(value)) return [];
  const reads: ConsumerRead[] = [];
  for (const entry of value) {
    const span = spanIn(entry);
    if (span === undefined) continue;
    const enclosing = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)['enclosing'] : undefined;
    reads.push({ ...span, ...(typeof enclosing === 'string' ? { enclosing } : {}) });
  }
  return reads;
}

/** A list of pairs (`[[name, [value, ...]], ...]`) a fact holds, as the map whose order the list keeps. */
function mapOfLists(value: unknown): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue;
    out.set(entry[0], entry[1].filter((held): held is string => typeof held === 'string'));
  }
  return out;
}

/**
 * The handler a consumer file delegates to, by the driver's own rule: the first interface method of
 * the file that exactly one file of its service declares, with the event kinds a switch of any file
 * names and whether any file decides a repeat by comparing a status.
 */
function handlerOf(rows: readonly GoConsumerRow[], own: GoConsumerRow): Record<string, unknown> {
  for (const name of own.interfaceMethods) {
    const candidates = rows.filter((row) => row.service === own.service && row.methods.some((method) => method.endsWith(`.${name}`)));
    if (candidates.length !== 1) continue;
    const methodFile = candidates[0]!;
    const method = methodFile.methods.find((held) => held.endsWith(`.${name}`));
    if (method === undefined) continue;
    const properties: Record<string, unknown> = { handler: method, handlerPath: methodFile.file };
    const kinds = new Set<string>();
    for (const row of rows) for (const kind of row.switchCases.get(name) ?? []) kinds.add(kind);
    if (kinds.size > 0) properties['eventKinds'] = [...kinds].sort(byCodePoint);
    const called = new Set<string>();
    for (const row of rows) for (const calledName of row.calledMethods.get(name) ?? []) called.add(calledName);
    if (rows.some((row) => row.statusComparisons.some((held) => called.has(held)))) properties['duplicates'] = 'status-comparison';
    return properties;
  }
  return {};
}

// ---- the channels a file's code publishes ---------------------------------

/** One publication site a file states, as the contracts-code stage published it. */
interface PublisherSiteRow {
  readonly span: SourceSpan;
  readonly channel?: string;
  readonly publisher?: string;
  readonly key?: string;
  readonly enclosing?: string;
  readonly evidence: readonly SourceSpan[];
  readonly service?: string;
}

/** One code file's constants and type unions, as the contracts-code stage published them. */
interface FileNamesRow {
  readonly file: string;
  readonly language: string;
  readonly service?: string;
  readonly consts: readonly (readonly [string, string])[];
  readonly typeUnions: readonly (readonly [string, readonly string[]])[];
}

/**
 * The publish links one file's sites state: a site whose topic resolves ends at the channel the
 * contract declares, once at the file and once at the callable the site stands in, with the
 * constant the service names the topic by and the event kinds its union states; a site whose topic
 * the outbox leaves unresolved is folded by the driver's own inference over the service's files
 * (madarch-8bdc.2.4).
 */
async function publishWrites(stage: StaticStageContext, source: StaticStageSource, repository: string, path: string, evidence: string, fileKey: string): Promise<readonly StageDraftWrite[]> {
  const sites = (await allPages((page) => stage.byProperty('code.publisher-site', 'file', path, page)))
    .filter((node) => node.properties['repository'] === repository)
    .map(publisherSiteOf)
    .filter((site): site is PublisherSiteRow => site !== undefined);
  if (sites.length === 0) return [];
  const names = (await allPages((page) => stage.byProperty('code.file-names', 'repository', repository, page))).map(fileNamesOf).filter((row): row is FileNamesRow => row !== undefined);
  const place = inputOf(repository, evidence);
  const writes: StageDraftWrite[] = [];
  const unresolved: PublisherSiteRow[] = [];
  for (const site of sites) {
    if (site.channel === undefined) { unresolved.push(site); continue; }
    if (!await channelExists(stage, site.channel)) continue;
    const properties: Record<string, unknown> = { topic: site.channel, publisher: site.publisher ?? '', evidence: site.evidence.map((span) => ({ ...span })) };
    if (site.key !== undefined) properties['key'] = site.key;
    const union = names.find((row) => row.file === path)?.typeUnions.find(([, members]) => members.length > 0 && members.every((member) => member.includes('.')));
    if (union !== undefined) properties['eventTypes'] = [...union[1]].sort(byCodePoint);
    const constant = constantOf(names, site.service, site.channel);
    if (constant !== undefined) { properties['constant'] = constant.name; properties['constantPath'] = constant.path; }
    writes.push(...linkWrites(REL_PUBLISHES, fileKey, site.enclosing, channelKey(site.channel), properties, site.span, place));
  }
  if (unresolved.length > 0) {
    writes.push(...await outboxWrites(stage, source, repository, path, unresolved, place));
  }
  return writes;
}

/** One publisher site's properties, or none where the node is not one of this reading's. */
function publisherSiteOf(node: StaticGraphNode): PublisherSiteRow | undefined {
  const span = spanIn(node.properties['span']);
  if (span === undefined) return undefined;
  const evidence = Array.isArray(node.properties['evidence']) ? (node.properties['evidence'] as readonly unknown[]).map(spanIn).filter((held): held is SourceSpan => held !== undefined) : [];
  return {
    span,
    ...(typeof node.properties['channel'] === 'string' ? { channel: node.properties['channel'] } : {}),
    ...(typeof node.properties['publisher'] === 'string' ? { publisher: node.properties['publisher'] } : {}),
    ...(typeof node.properties['key'] === 'string' ? { key: node.properties['key'] } : {}),
    ...(typeof node.properties['enclosing'] === 'string' ? { enclosing: node.properties['enclosing'] } : {}),
    evidence,
    ...(typeof node.properties['service'] === 'string' ? { service: node.properties['service'] } : {}),
  };
}

/** One file-names row's constants and unions. */
function fileNamesOf(node: StaticGraphNode): FileNamesRow | undefined {
  const file = node.properties['file'];
  if (typeof file !== 'string') return undefined;
  const pairs = (value: unknown): { readonly name: string; readonly value: string }[] => Array.isArray(value)
    ? value.filter((entry): entry is readonly [string, string] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string').map(([name, held]) => ({ name, value: held }))
    : [];
  const unions = Array.isArray(node.properties['typeUnions'])
    ? node.properties['typeUnions'].flatMap((entry): (readonly [string, readonly string[]])[] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && Array.isArray(entry[1]) ? [[entry[0], entry[1].filter((member): member is string => typeof member === 'string')] as const] : [])
    : [];
  return {
    file,
    language: String(node.properties['language'] ?? ''),
    ...(typeof node.properties['service'] === 'string' ? { service: node.properties['service'] } : {}),
    consts: pairs(node.properties['consts']).map((entry) => [entry.name, entry.value] as const),
    typeUnions: unions,
  };
}

/**
 * The constant the service names one topic by: the driver's own search, over the service's Go files
 * first and then its TypeScript files, each in code point order of its path.
 */
function constantOf(rows: readonly FileNamesRow[], service: string | undefined, channel: string): { readonly name: string; readonly path: string } | undefined {
  const held = rows.filter((row) => row.service === service);
  const ordered = held.filter((row) => row.language === 'go').sort((left, right) => byCodePoint(left.file, right.file))
    .concat(held.filter((row) => row.language !== 'go').sort((left, right) => byCodePoint(left.file, right.file)));
  for (const row of ordered) for (const [name, value] of row.consts) if (value === channel) return { name, path: row.file };
  return undefined;
}

/** Whether the graph holds the channel node of a topic. */
async function channelExists(stage: StaticStageContext, channel: string): Promise<boolean> {
  const rows = await stage.byKey(channelKey(channel), { limit: 2 });
  return rows.some((node) => node.kind === 'code.channel');
}

/** One link's edges: the file-level summary edge and the callable's own edge, both at the site. */
function linkWrites(relation: string, fileKey: string, enclosing: string | undefined, target: string, properties: Readonly<Record<string, unknown>>, span: SourceSpan, place: { readonly repository: string; readonly evidence: string; readonly commit: string }): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [edgeWrite(relation, fileKey, target, { span, discriminator: String(span.byteStart) }, place, { ...properties, summary: true })];
  if (enclosing !== undefined) writes.push(edgeWrite(relation, enclosing, target, { span, discriminator: String(span.byteStart) }, place, properties));
  return writes;
}

/**
 * The publications the outbox inference proves for a file's unresolved sites: the driver's own
 * reading over the facts of the service the file belongs to, rebuilt from the graph one file at a
 * time. The service's files are the per-file unit facts it declares, never a folder's shape.
 */
async function outboxWrites(stage: StaticStageContext, source: StaticStageSource, repository: string, path: string, unresolved: readonly PublisherSiteRow[], place: { readonly repository: string; readonly evidence: string; readonly commit: string }): Promise<readonly StageDraftWrite[]> {
  const service = unresolved.find((site) => site.service !== undefined)?.service;
  if (service === undefined) return [];
  const units = (await allPages((page) => stage.byProperty('code.service-unit', 'name', service, page)))
    .filter((node) => node.properties['repository'] === repository);
  const files = [...new Set(units.flatMap((node) => typeof node.properties['file'] === 'string' ? [node.properties['file'] as string] : []))].sort(byCodePoint);
  const views = [];
  for (const file of files) {
    const held = await source.file(file);
    if (held?.content === undefined) continue;
    views.push(await fileCodeViewOf(stage, repository, file, held.content));
  }
  if (views.length === 0) return [];
  const facts = {
    files: views.flatMap((view) => view.facts.files),
    expressions: views.flatMap((view) => view.facts.expressions),
    bindings: views.flatMap((view) => view.facts.bindings),
    calls: views.flatMap((view) => view.facts.calls),
    symbols: views.flatMap((view) => view.facts.symbols),
    imports: views.flatMap((view) => view.facts.imports),
    sites: views.flatMap((view) => view.facts.sites),
    fields: views.flatMap((view) => view.facts.fields ?? []),
  };
  const outbox = await inferOutboxPublications(facts, { edges: views.flatMap((view) => view.code.edges) }, unresolved.map((site) => ({ span: site.span, evidence: site.evidence })), (asked) => files.includes(asked) ? service : undefined);
  const writes: StageDraftWrite[] = [];
  const enclosingOf = new Map(unresolved.map((site) => [`${site.span.path}:${String(site.span.byteStart)}:${String(site.span.byteEnd)}`, site.enclosing]));
  for (const site of outbox.sites) {
    if (!await channelExists(stage, site.channel)) continue;
    const properties: Record<string, unknown> = { topic: site.channel, via: 'outbox', evidence: site.evidence.map((span) => ({ ...span })) };
    if (site.constant !== undefined) { properties['constant'] = site.constant; properties['constantPath'] = site.constantPath ?? ''; }
    const enclosing = enclosingOf.get(`${site.span.path}:${String(site.span.byteStart)}:${String(site.span.byteEnd)}`);
    writes.push(...linkWrites(REL_PUBLISHES, fileFactIdOf(repository, site.span.path), enclosing, channelKey(site.channel), properties, site.span, place));
  }
  return writes;
}

// ---- the reads one unit makes ---------------------------------------------

/** Every page of one bounded read. */
async function allPages<T>(fetch: (page: { readonly limit: number; readonly after?: string }) => Promise<{ readonly rows: readonly T[]; readonly next: string | null }>): Promise<readonly T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after === undefined ? { limit: 256 } : { limit: 256, after });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** The unit one file belongs to, from the code-facts stage's own fact. */
async function serviceOf(stage: StaticStageContext, path: string): Promise<string | undefined> {
  const nodes = await allPages((page) => stage.byProperty('code.service-unit', 'file', path, page));
  const names = new Set(nodes.flatMap((node) => typeof node.properties['name'] === 'string' ? [node.properties['name'] as string] : []));
  return names.size === 1 ? [...names][0] : undefined;
}

/** An array property, as the strings it holds. */
function arrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** One place property, as a span: a record's `span` or a provenance place's range. */
function spanIn(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const held = value as Record<string, unknown>;
  const range = held['range'] !== undefined && held['range'] !== null && typeof held['range'] === 'object' ? held['range'] as Record<string, unknown> : held;
  const path = typeof held['path'] === 'string' ? held['path'] : typeof held['file'] === 'string' ? held['file'] : undefined;
  // A record's own span names `byteStart`/`byteEnd`; a provenance place's range names
  // `startByte`/`endByte`. Both are the same place, and a reader accepts either.
  const start = typeof range['startByte'] === 'number' ? range['startByte'] : range['byteStart'];
  const end = typeof range['endByte'] === 'number' ? range['endByte'] : range['byteEnd'];
  if (path === undefined || typeof start !== 'number' || typeof end !== 'number') return undefined;
  return {
    path,
    byteStart: start,
    byteEnd: end,
    lineStart: typeof range['startLine'] === 'number' ? range['startLine'] : typeof range['lineStart'] === 'number' ? range['lineStart'] : 1,
    lineEnd: typeof range['endLine'] === 'number' ? range['endLine'] : typeof range['lineEnd'] === 'number' ? range['lineEnd'] : 1,
  };
}

/** The byte span a node's place names: the record's own `span`, or the place its provenance names. */
function spanOfNode(node: StaticGraphNode): SourceSpan | undefined {
  const own = node.properties['span'];
  if (own !== null && typeof own === 'object') {
    const held = own as Record<string, unknown>;
    if (typeof held['path'] === 'string' && typeof held['byteStart'] === 'number' && typeof held['byteEnd'] === 'number') {
      return {
        path: held['path'],
        byteStart: held['byteStart'],
        byteEnd: held['byteEnd'],
        lineStart: typeof held['lineStart'] === 'number' ? held['lineStart'] : 1,
        lineEnd: typeof held['lineEnd'] === 'number' ? held['lineEnd'] : 1,
      };
    }
  }
  const provenance = node.properties['provenance'];
  if (provenance === null || typeof provenance !== 'object') return undefined;
  const place = (provenance as Record<string, unknown>)['place'];
  if (place === null || typeof place !== 'object') return undefined;
  const file = (place as Record<string, unknown>)['file'];
  const range = (place as Record<string, unknown>)['range'];
  if (typeof file !== 'string' || range === null || typeof range !== 'object') return undefined;
  const held = range as Record<string, unknown>;
  if (typeof held['startByte'] !== 'number' || typeof held['endByte'] !== 'number') return undefined;
  return {
    path: file,
    byteStart: held['startByte'],
    byteEnd: held['endByte'],
    lineStart: typeof held['startLine'] === 'number' ? held['startLine'] : 1,
    lineEnd: typeof held['endLine'] === 'number' ? held['endLine'] : 1,
  };
}

/** The key the graph holds a node under. */
function recordKeyOf(node: StaticGraphNode): string {
  const key = node.properties['recordKey'];
  if (typeof key !== 'string') throw new Error(`the graph answered a ${node.kind} node (${node.id}) with no recordKey (src/fill/stages/contracts-links.ts)`);
  return key;
}

// ---- what one unit's draft writes ----------------------------------------

/** The two parts every edge of this stage cites. */
function inputOf(repository: string, evidence: string): { readonly repository: string; readonly evidence: string; readonly commit: string } {
  return { repository, evidence, commit: commitOf(evidence) };
}

/** The span of a whole file: its first line to its last, its first byte to its length. */
function wholeFileSpan(path: string, bytes: Uint8Array): SourceSpan {
  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text === '' ? 1 : text.split('\n').length;
  return { path, byteStart: 0, byteEnd: bytes.byteLength, lineStart: 1, lineEnd: lines };
}

/** One node write of this stage: the record, its span and the envelope the graph holds it with. */
function nodeWrite(key: string, kind: string, label: string, properties: Readonly<Record<string, unknown>>, span: SourceSpan, repository: string, evidence: string, factKind: string): StageDraftWrite {
  return {
    kind: 'node',
    evidence,
    value: {
      key,
      kind,
      label,
      properties: {
        ...properties,
        span: { ...span },
        recordKey: key,
        factKind,
        layer: 'extracted',
        repository,
        provenance: { source: CONTRACTS_LINKS_SOURCE, repository: { id: repository, commit: commitOf(evidence) }, place: { file: span.path, range: { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0, startByte: span.byteStart, endByte: span.byteEnd } } },
      },
    },
  };
}

/** One edge of an entry point or a link: its record's properties, its span and the discriminator. */
function recordEdge(relation: string, from: string, to: string, extra: Readonly<Record<string, unknown>>, span: SourceSpan, evidence: string, repository: string, discriminator = ''): StageDraftWrite {
  return edgeWrite(relation, from, to, { span, discriminator }, inputOf(repository, evidence), extra);
}

/** One edge write of this stage. */
function edgeWrite(relation: string, from: string, to: string, record: { readonly span?: SourceSpan; readonly discriminator: string }, place: { readonly repository: string; readonly evidence: string; readonly commit: string }, extra: Readonly<Record<string, unknown>>): StageDraftWrite {
  return {
    kind: 'edge',
    evidence: place.evidence,
    value: {
      relation,
      from: { key: from },
      to: { key: to },
      properties: {
        ...extra,
        factKind: relation.slice('code.'.length),
        layer: 'extracted',
        repository: place.repository,
        discriminator: record.discriminator,
        ...(record.span === undefined ? {} : { span: { ...record.span } }),
        provenance: { source: CONTRACTS_LINKS_SOURCE, repository: { id: place.repository, commit: place.commit }, ...(record.span === undefined ? {} : { place: { file: record.span.path, range: { startLine: record.span.lineStart, startColumn: 0, endLine: record.span.lineEnd, endColumn: 0, startByte: record.span.byteStart, endByte: record.span.byteEnd } } }) },
      },
    },
  };
}

/** The commit the evidence text names. */
function commitOf(evidence: string): string {
  const at = evidence.indexOf('@');
  const rest = at < 0 ? evidence : evidence.slice(at + 1);
  const end = rest.indexOf(':');
  return end < 0 ? rest : rest.slice(0, end);
}

/** One file's coverage: what was read, and every place this stage could not read, with the blob the bytes stood under. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: CONTRACTS_LINKS_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob } } }
      : write);
  }
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the contracts-links stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/contracts-links.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/contracts-links.ts)`);
  }
}
