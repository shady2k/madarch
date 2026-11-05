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
import { readGoFile } from '../../extract/contracts/go-code.js';
import { REL_SERVES } from '../../extract/contracts/schema.js';
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
const CONTRACTS_LINKS_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
const CONTRACTS_LINKS_STAGE_KINDS: readonly string[] = ['contains', 'coverage', 'serves'];

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
      ],
    },
    produces: [
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'serves', schemaVersion: 1, scope: 'file' },
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
  writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: true, read: [planned.path], unread: [] }, entry.id);
  context.progress(`read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(edges.length)} ${edges.length === 1 ? 'serving link' : 'serving links'}`, 1);
  return { outcome: 'draft' };
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
