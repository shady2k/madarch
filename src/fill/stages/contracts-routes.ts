/**
 * The routes a repository's code registers, as a static stage (decision 0033,
 * items 5, 7, 14 and 15; madarch-8bdc.2.4): one unit per source file, the file's
 * own bytes, and the routes, handlers and callback registrations its code
 * states.
 *
 * **Why this stage stands after `contracts-code`.** A route's final path, its
 * middleware chain and its auth group are facts of *another* file: a router
 * factory built in one file is mounted with a prefix in the service's app, and
 * the app's own middlewares wrap it. A stage's units run at once, so the file
 * that states the route cannot read a mount another unit publishes in the same
 * stage. The mounts, the middleware names and the inline callbacks are
 * published as per-file facts by `contracts-code`, and this stage reads them
 * through bounded reads by service (decision 0033, item 5; the coordinator's
 * decision 1: later stages are the order's normal answer).
 *
 * **What it publishes.** One `code.route` per registration, with the method, the
 * path (the mount's prefix joined), the ports of the service's listener, the
 * service, the middleware chain, the auth group and algorithm, and the handler's
 * file and key; the `code.handled-by` edge from the route to the handler; the
 * `code.references` edge from the enclosing function to the handler, positioned
 * at the registration; and the `code.contains` edge that reaches the route from
 * its file. A route's handler is the syntax stage's node for the declaration
 * (found by a bounded read by qualified name) or the inline callback
 * `contracts-code` published for that span — never a second symbol node.
 *
 * **What it reads, and what it does not.** The file's bytes (its own routes, its
 * own middleware chain, its handler expressions), the `code.service-unit` and
 * `code.listener-port` facts of the file's unit, the `code.router-mount`,
 * `code.middleware-chain` and `code.callback` facts `contracts-code` published,
 * and the syntax stage's `code.symbol` nodes. No whole-tree object is held and
 * no tree is listed.
 *
 * **Assumptions the driver's finer rules do not reach yet.** A route's `ports`
 * are the listener ports of the service its file belongs to (the driver resolves
 * the receiver/listener association through the code facts; the fill publishes
 * the per-file port fact, not that association). A Go method value passed as an
 * `http.Handler` (a field whose type declares `ServeHTTP`) resolves to that
 * method. Both are named in the change record.
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
import { readGoFile, type GoFileFacts } from '../../extract/contracts/go-code.js';
import {
  EDGE_CONTAINS, EDGE_HANDLED_BY, EDGE_REFERENCES, KIND_ROUTE, routeKey,
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
const CONTRACTS_ROUTES_STAGE_ID = 'contracts-routes';

/** The stage's own version, bumped when what it writes or plans changes. */
const CONTRACTS_ROUTES_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
const CONTRACTS_ROUTES_STAGE_KINDS: readonly string[] = ['contains', 'coverage', 'handled-by', 'references', 'route'];

/** The reader every fact of this stage cites. */
export const CONTRACTS_ROUTES_SOURCE_SYSTEM = 'madarch-contracts-routes';

/** The reader every fact of this stage cites. */
const CONTRACTS_ROUTES_SOURCE: FactSource = { system: CONTRACTS_ROUTES_SOURCE_SYSTEM, version: '1' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_CONTRACTS_ROUTES_READ = 'stage-contracts-routes-published';

/** The read of one repository's published routes: one row per file this stage read. */
function publishedContractsRoutesRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_CONTRACTS_ROUTES_READ, repository });
}

/** One row of that read: one file this stage read, at the blob its bytes stood under. */
interface PublishedContractsRoutesRow {
  readonly kind: 'coverage';
  readonly path: string;
  readonly blob?: string;
}

/** The keys a row of that read holds, and no others. */
const CONTRACTS_ROUTES_ROW_FIELDS: readonly string[] = ['blob', 'kind', 'path', 'repository'];

/** The stage, built over the source that holds the run's pins. */
export function createContractsRoutesStage(sources: SnapshotSource): FillStage {
  return {
    id: CONTRACTS_ROUTES_STAGE_ID,
    version: CONTRACTS_ROUTES_STAGE_VERSION,
    staticReading: true,
    consumes: {
      required: [{ capability: 'file', scope: 'repository', freshness: 'current' }],
      optional: [
        // The per-file facts the contracts-code stage publishes: the mounts, the middleware names
        // and the inline callbacks a route is read through.
        { capability: 'router-mount', scope: 'repository', freshness: 'current' },
        { capability: 'middleware-chain', scope: 'repository', freshness: 'current' },
        { capability: 'callable', scope: 'repository', freshness: 'current' },
        // The unit a file belongs to and the ports it listens on, and the symbols a handler names.
        { capability: 'service-unit', scope: 'repository', freshness: 'current' },
        { capability: 'listener-port', scope: 'repository', freshness: 'current' },
        { capability: 'field', scope: 'repository', freshness: 'current' },
        { capability: 'symbol', scope: 'repository', freshness: 'current' },
        // The resolution stage's own links: a registration it already tied is the same edge, and the
        // graph holds one edge per relation and two ends (decision 0028), so this stage adds only the
        // registrations the resolution did not tie.
        { capability: 'reference', scope: 'repository', freshness: 'current' },
      ],
    },
    produces: [
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'handled-by', schemaVersion: 1, scope: 'file' },
      { kind: 'references', schemaVersion: 1, scope: 'file' },
      { kind: 'route', schemaVersion: 1, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planContractsRoutes(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeContractsRoutesUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(CONTRACTS_ROUTES_STAGE_ID, CONTRACTS_ROUTES_STAGE_KINDS, draft),
  };
}

/**
 * Whether a path is a file this stage reads: the extract driver's own source
 * rule (`src/extract/contracts/index.ts`, `isSourcePath`) — the files whose
 * routes it publishes.
 */
function isRoutePath(path: string): boolean {
  return (path.endsWith('.ts') || path.endsWith('.go'))
    && !path.endsWith('.d.ts')
    && !/(^|\/)(test|tests|__tests__)\//.test(path)
    && !/\.(test|spec)\.[tj]s$/.test(path)
    && !path.endsWith('_test.go');
}

// ---- planning ------------------------------------------------------------

/** The units one run fills: a unit per source file this stage's coverage does not name at the pinned blob, and one per published file the commit no longer holds. */
async function planContractsRoutes(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const ownRead = publishedContractsRoutesRead(pin.id);
    const own = publishedContractsRoutesRows(await graph.query(ownRead), pin.id, ownRead);
    const readBlobs = new Map<string, string | undefined>(own.map((row) => [row.path, row.blob]));
    const mine = reader.files().filter((entry) => isRoutePath(entry.path));
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

/** The plan's own read, read: each row is one file this stage read and the blob its bytes stood under. */
function publishedContractsRoutesRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedContractsRoutesRow[] {
  return rows.map((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind and its path`);
    const held = row as Record<string, unknown>;
    for (const key of Object.keys(held).sort(byCodePoint)) {
      if (!CONTRACTS_ROUTES_ROW_FIELDS.includes(key)) throw refuse(`it holds ${JSON.stringify(key)}, and a row holds ${CONTRACTS_ROUTES_ROW_FIELDS.join(', ')}`);
    }
    if (held['kind'] !== 'coverage') throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" rows`);
    const path = held['path'];
    if (typeof path !== 'string' || !isRepositoryPath(path) || !isRoutePath(path)) throw refuse(`its path ${JSON.stringify(path)} is no source file of this reading`);
    const blob = held['blob'];
    if (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob))) throw refuse(`its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    return { kind: 'coverage', path, ...(blob === undefined ? {} : { blob }) };
  });
}

// ---- one unit ------------------------------------------------------------

/** One route the unit publishes, before its draft writes. */
interface RouteRecord {
  readonly key: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
  readonly span: SourceSpan;
  readonly handler?: { readonly key: string; readonly path: string };
  readonly handlerSpan?: SourceSpan;
  /** The innermost callable the registration stands in, as the file's own symbols name it. */
  readonly enclosing?: string;
}

/** One unit: the source file the unit names, its routes and the facts of its service they are read through. */
async function executeContractsRoutesUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
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
    writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: false, read: [], unread: [{ what: `${planned.path} at ${String(CONTRACTS_ROUTES_SOURCE.system)} ${CONTRACTS_ROUTES_SOURCE.version}`, reason }] }, entry.id);
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
  const ports = service === undefined ? [] : await servicePorts(stage, service);
  const auth = service === undefined ? undefined : await authMiddlewareOf(stage, service);
  const mounts = service === undefined ? [] : await nodesOf(stage, 'code.router-mount', 'service', service);
  const callables = await nodesOf(stage, 'code.callable', 'file', planned.path);
  const symbols = await nodesOf(stage, 'code.symbol', 'file', planned.path);
  // The reference links the resolution stage published for this file: a registration it tied is one
  // edge the graph already holds, and this stage publishes only the ones it left untied.
  const existing = await allPages((page) => stage.edgesByProperty('code.references', 'file', planned.path, page));
  const existingLinks = new Set(existing.map((entry) => `${recordKeyOf(entry.from)}\u0000${recordKeyOf(entry.to)}`));
  const routes = isGo
    ? await goRoutes(stage, planned.path, read.value as GoFileFacts, { service, ports, auth, mounts, callables, symbols, repository: planned.repository })
    : tsRoutes(planned.path, read.value as TsFileFacts, { service, ports, auth, mounts, callables, symbols, repository: planned.repository });
  const evidence = evidenceAtPlace(source, planned.path);
  const fileKey = fileFactIdOf(planned.repository, planned.path);
  for (const route of routes) {
    for (const write of routeWrites({ repository: planned.repository, fileKey, evidence, route, existingLinks })) context.draft.write(write);
  }
  writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: true, read: [planned.path], unread: [] }, entry.id);
  context.progress(`read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(routes.length)} ${routes.length === 1 ? 'route' : 'routes'}`, 1);
  return { outcome: 'draft' };
}

/** The routes one TypeScript file states, with the mount, the chain and the handler each resolves through. */
function tsRoutes(path: string, facts: TsFileFacts, read: RouteRead): readonly RouteRecord[] {
  const records: RouteRecord[] = [];
  for (const route of facts.routes) {
    const mount = route.routerFactory === undefined ? undefined : read.mounts.find((node) => node.properties['factory'] === route.routerFactory);
    const chain = mount === undefined
      ? [...route.middleware]
      : [...arrayOf(mount.properties['appMiddlewares']), ...arrayOf(mount.properties['middlewares']), ...route.middleware];
    const routePath = mount === undefined ? route.path : joinPath(String(mount.properties['prefix'] ?? ''), route.path);
    const authName = read.auth === undefined ? undefined : chain.find((name) => name === read.auth);
    const handler = route.handler === undefined ? undefined : resolveHandler(path, route.handler, read);
    const key = routeKey(path, route.method, routePath);
    records.push({
      key,
      label: `${route.method} ${routePath}`,
      properties: {
        method: route.method,
        ports: [...read.ports],
        path: routePath,
        ...(read.service === undefined ? {} : { service: read.service }),
        ...(handler === undefined ? {} : { handlerKey: handler.key, handlerPath: handler.path }),
        middleware: chain,
        authGroup: authName !== undefined,
        ...(authName === undefined ? {} : { authAlgorithm: 'HS256' }),
      },
      span: route.span,
      ...(handler === undefined ? {} : { handler }),
      ...(route.handler === undefined ? {} : { handlerSpan: route.handler.span }),
      ...enclosingOf(read, route.span),
    });
  }
  return records;
}

/** The routes one Go file states, with the service's chain, the ports and the handler each resolves to. */
async function goRoutes(stage: StaticStageContext, path: string, facts: GoFileFacts, read: RouteRead): Promise<readonly RouteRecord[]> {
  const records: RouteRecord[] = [];
  for (const route of facts.routes) {
    const authName = read.auth;
    const handler = route.inline
      ? resolveHandler(path, { text: route.handler, inline: true, span: route.handlerSpan }, read)
      : await resolveGoHandler(stage, read, route.handlerSymbol, route.handler);
    const key = routeKey(path, route.method, route.path);
    records.push({
      key,
      label: `${route.method} ${route.path}`,
      properties: {
        method: route.method,
        path: route.path,
        handler: route.handler,
        ports: [...read.ports],
        handlerSymbol: route.handlerSymbol,
        middleware: [...route.middleware],
        authGroup: route.authGroup,
        ...(read.service === undefined ? {} : { service: read.service }),
        ...(route.authGroup && authName !== undefined && route.middleware.some((name) => name.replace(/\(.*/, '') === authName) ? { authAlgorithm: 'HS256' } : {}),
        ...(handler === undefined ? {} : { handlerPath: handler.path, handlerKey: handler.key }),
      },
      span: route.span,
      ...(handler === undefined ? {} : { handler }),
      handlerSpan: route.handlerSpan,
      ...enclosingOf(read, route.span),
    });
  }
  return records;
}

/** What one file's routes are read through: the service, its ports, its auth middleware and the facts of other files. */
interface RouteRead {
  readonly service: string | undefined;
  readonly ports: readonly string[];
  readonly auth: string | undefined;
  readonly mounts: readonly StaticGraphNode[];
  readonly callables: readonly StaticGraphNode[];
  readonly symbols: readonly StaticGraphNode[];
  readonly repository: string;
}

/** The handler a route's registration names: the inline callable at its span, or the file's own declaration of the name it writes. */
function resolveHandler(path: string, handler: { readonly text: string; readonly inline: boolean; readonly span: SourceSpan }, read: RouteRead): { readonly key: string; readonly path: string } | undefined {
  if (handler.inline) {
    // The code-facts stage's callable fact names every callable the extract readings name, an inline
    // handler among them, at the span it stands over (madarch-8bdc.2.4; decision 4 of the port).
    const callables = read.callables.filter((node) => {
      const at = spanOfNode(node);
      return at !== undefined && at.byteStart === handler.span.byteStart && at.byteEnd === handler.span.byteEnd;
    });
    if (callables.length !== 1) return undefined;
    return { key: recordKeyOf(callables[0]!), path };
  }
  // A named handler this file declares: the syntax stage's symbol for it, and the callable fact where
  // the syntax pass keeps no node of the name. A handler reached through an import or a field is no
  // proof this file holds, and the route is published without one (a gap).
  const symbols = read.symbols.filter((node) => node.properties['qualifiedName'] === handler.text);
  if (symbols.length === 1) return { key: recordKeyOf(symbols[0]!), path: String(symbols[0]!.properties['file'] ?? path) };
  const callables = read.callables.filter((node) => node.properties['qualifiedName'] === handler.text);
  if (callables.length === 1) return { key: recordKeyOf(callables[0]!), path };
  return undefined;
}

/** The handler a Go registration names, by the file's own field proof and the symbols of the service. */
async function resolveGoHandler(stage: StaticStageContext, read: RouteRead, handlerSymbol: string, handler: string): Promise<{ readonly key: string; readonly path: string } | undefined> {
  const symbol = await symbolByName(stage, read.repository, handlerSymbol);
  if (symbol !== undefined) return { key: recordKeyOf(symbol), path: String(symbol.properties['file'] ?? '') };
  // A method value passed as an `http.Handler`: the field the expression names, whose type declares
  // `ServeHTTP`. The field's type is the code-facts stage's own reading of the file's struct.
  const member = handler.slice(handler.lastIndexOf('.') + 1);
  if (member === handler) return undefined;
  const fields = await nodesOf(stage, 'code.field', 'name', member);
  const types = new Set<string>();
  for (const node of fields) {
    const type = node.properties['typeExpression'];
    if (typeof type !== 'string') continue;
    const name = await typeNameOf(stage, type);
    if (name !== undefined) types.add(name);
  }
  const candidates: StaticGraphNode[] = [];
  for (const type of types) {
    const method = await symbolByName(stage, read.repository, `${type}.ServeHTTP`);
    if (method !== undefined) candidates.push(method);
  }
  if (candidates.length !== 1) return undefined;
  const found = candidates[0]!;
  return { key: recordKeyOf(found), path: String(found.properties['file'] ?? '') };
}

/** The symbol the driver's own route reader names for a handler expression, where the file proves one. */
function handlerSymbolOf(facts: GoFileFacts, handler: string): string {
  const dot = handler.lastIndexOf('.');
  const owner = dot > 0 ? handler.slice(0, dot) : '';
  const owned = owner.includes('.') ? owner.slice(owner.lastIndexOf('.') + 1) : owner;
  const fieldType = facts.structFields.get(owned) ?? facts.receiverNames.get(owned);
  return fieldType === undefined ? handler : `${fieldType}.${handler.slice(dot + 1)}`;
}

/** One symbol of the repository by its qualified name: exactly one answers, and two are no answer. */
async function symbolByName(stage: StaticStageContext, repository: string, qualifiedName: string): Promise<StaticGraphNode | undefined> {
  const nodes = (await allPages((page) => stage.byProperty('code.symbol', 'qualifiedName', qualifiedName, page)))
    .filter((node) => node.properties['repository'] === repository);
  return nodes.length === 1 ? nodes[0] : undefined;
}

/** The innermost callable of the file whose body holds a registration: what a callback registration stands in. */
function enclosingOf(read: RouteRead, span: SourceSpan): { readonly enclosing?: string } {
  const held = read.callables.filter((node) => {
    const at = spanOfNode(node);
    const body = spanOfProperty(node, 'bodySpan');
    return at !== undefined && body !== undefined && at.byteStart <= span.byteStart && body.byteStart <= span.byteStart && span.byteEnd <= body.byteEnd;
  }).sort((left, right) => {
    const a = spanOfNode(left)!;
    const b = spanOfNode(right)!;
    return (a.byteEnd - a.byteStart) - (b.byteEnd - b.byteStart);
  });
  if (held.length === 0) return {};
  const chosen = held[0]!;
  // The record names the syntax stage's node for the declaration; the callable fact is the node where
  // the syntax pass keeps none (an inline callback).
  const qualified = chosen.properties['qualifiedName'];
  const symbol = read.symbols.filter((node) => node.properties['qualifiedName'] === qualified);
  return { enclosing: symbol.length === 1 ? recordKeyOf(symbol[0]!) : recordKeyOf(chosen) };
}

/** One span property of a node (a callable's body, say), where it carries one. */
function spanOfProperty(node: StaticGraphNode, name: string): SourceSpan | undefined {
  const value = node.properties[name];
  if (value === null || typeof value !== 'object') return undefined;
  const held = value as Record<string, unknown>;
  if (typeof held['path'] !== 'string' || typeof held['byteStart'] !== 'number' || typeof held['byteEnd'] !== 'number') return undefined;
  return {
    path: held['path'],
    byteStart: held['byteStart'],
    byteEnd: held['byteEnd'],
    lineStart: typeof held['lineStart'] === 'number' ? held['lineStart'] : 1,
    lineEnd: typeof held['lineEnd'] === 'number' ? held['lineEnd'] : 1,
  };
}

/** The type name one field's type expression stands for: the identifier it names, through a pointer's own child. */
async function typeNameOf(stage: StaticStageContext, expression: string): Promise<string | undefined> {
  const node = (await stage.byKey(expression, { limit: 1 }))[0];
  if (node === undefined) return undefined;
  if (typeof node.properties['name'] === 'string') return node.properties['name'] as string;
  const children = arrayOf(node.properties['children']);
  if (children.length !== 1) return undefined;
  const child = (await stage.byKey(children[0]!, { limit: 1 }))[0];
  return typeof child?.properties['name'] === 'string' ? child.properties['name'] as string : undefined;
}

/** What one route's draft writes: the route, its handler edges and its containment. */
function routeWrites(input: { readonly repository: string; readonly fileKey: string; readonly evidence: string; readonly route: RouteRecord; readonly existingLinks: ReadonlySet<string> }): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [];
  const commit = commitOf(input.evidence);
  const route = input.route;
  writes.push(nodeWrite({
    key: route.key,
    kind: KIND_ROUTE,
    label: route.label,
    properties: route.properties,
  }, route.span, input.repository, commit, input.evidence, 'route'));
  writes.push(edgeWrite(EDGE_CONTAINS, input.fileKey, route.key, { span: route.span, discriminator: '' }, input.repository, input.evidence, commit));
  if (route.handler !== undefined && route.handlerSpan !== undefined) {
    writes.push(edgeWrite(EDGE_HANDLED_BY, route.key, route.handler.key, { span: route.handlerSpan, discriminator: '' }, input.repository, input.evidence, commit));
    const enclosing = enclosingSymbolOf(route, input.fileKey);
    // One link is one edge (decision 0028): where the resolution stage already tied this registration,
    // the graph holds its edge and this stage adds none; where it did not (an inline callback is no
    // mention), this stage publishes the registration's own positioned record.
    if (!input.existingLinks.has(`${enclosing}\u0000${route.handler.key}`)) {
      writes.push(edgeWrite(EDGE_REFERENCES, enclosing, route.handler.key, { span: route.handlerSpan, discriminator: String(route.handlerSpan.byteStart), role: 'callback-registration' }, input.repository, input.evidence, commit));
    }
  }
  return writes;
}

/** The enclosing symbol a registration stands in: the innermost callable the unit's symbols answer at its place. */
function enclosingSymbolOf(route: RouteRecord, fileKey: string): string {
  return route.enclosing ?? fileKey;
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

/** Every current node of one kind carrying a value in a property. */
async function nodesOf(stage: StaticStageContext, kind: string, field: string, value: string): Promise<readonly StaticGraphNode[]> {
  return await allPages((page) => stage.byProperty(kind, field, value, page));
}

/** The unit one file belongs to, from the code-facts stage's own fact. */
async function serviceOf(stage: StaticStageContext, path: string): Promise<string | undefined> {
  const nodes = await nodesOf(stage, 'code.service-unit', 'file', path);
  const names = new Set(nodes.flatMap((node) => typeof node.properties['name'] === 'string' ? [node.properties['name'] as string] : []));
  return names.size === 1 ? [...names][0] : undefined;
}

/** The ports a service's own code listens on: its listener-port facts, the test files' ports left out. */
async function servicePorts(stage: StaticStageContext, service: string): Promise<readonly string[]> {
  const nodes = await nodesOf(stage, 'code.listener-port', 'service', service);
  const ports = new Set<string>();
  for (const node of nodes) {
    const file = node.properties['file'];
    const port = node.properties['port'];
    if (typeof file !== 'string' || typeof port !== 'string' || !isRoutePath(file)) continue;
    ports.add(port);
  }
  return [...ports].sort(byCodePoint);
}

/**
 * The middleware a service's auth group uses, by the driver's own rule: the files
 * in the driver's order (Go files first, then TypeScript, each by path), the
 * first file whose middleware names include one a file of the service proves an
 * HS256 verifier for, and the first such name in that file's own order.
 */
async function authMiddlewareOf(stage: StaticStageContext, service: string): Promise<string | undefined> {
  const chains = await nodesOf(stage, 'code.middleware-chain', 'service', service);
  const hs256 = new Set(chains.flatMap((node) => arrayOf(node.properties['hs256'])));
  const ordered = [...chains].sort((left, right) => {
    const language = (node: StaticGraphNode): number => node.properties['language'] === 'go' ? 0 : 1;
    return language(left) - language(right) || byCodePoint(String(left.properties['file']), String(right.properties['file']));
  });
  for (const chain of ordered) {
    for (const name of arrayOf(chain.properties['names'])) if (hs256.has(name)) return name;
  }
  return undefined;
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

/** The key the graph holds a node under: the record key it carries. */
function recordKeyOf(node: StaticGraphNode): string {
  const key = node.properties['recordKey'];
  if (typeof key !== 'string') throw new Error(`the graph answered a ${node.kind} node (${node.id}) with no recordKey: every static node carries the fact id it was read as (src/fill/stages/contracts-routes.ts)`);
  return key;
}

// ---- what one unit's draft writes ----------------------------------------

/** One node write of this stage: the record, its span and the envelope the graph holds it with. */
function nodeWrite(node: { readonly key: string; readonly kind: string; readonly label: string; readonly properties: Readonly<Record<string, unknown>> }, span: SourceSpan, repository: string, commit: string, evidence: string, factKind: string): StageDraftWrite {
  return {
    kind: 'node',
    evidence,
    value: {
      key: node.key,
      kind: node.kind,
      label: node.label,
      properties: {
        ...node.properties,
        span: { ...span },
        recordKey: node.key,
        factKind,
        layer: 'extracted',
        repository,
        provenance: { source: CONTRACTS_ROUTES_SOURCE, repository: { id: repository, commit }, place: { file: span.path, range: { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0, startByte: span.byteStart, endByte: span.byteEnd } } },
      },
    },
  };
}

/** One edge write of this stage: its record's properties, its span and the discriminator the driver gives it. */
function edgeWrite(relation: string, from: string, to: string, record: { readonly span?: SourceSpan; readonly discriminator: string; readonly role?: string; readonly position?: { readonly start: number; readonly end: number } }, repository: string, evidence: string, commit: string): StageDraftWrite {
  return {
    kind: 'edge',
    evidence,
    value: {
      relation,
      from: { key: from },
      to: { key: to },
      ...(record.position === undefined ? {} : { position: { start: record.position.start, end: record.position.end } }),
      properties: {
        factKind: relation.slice('code.'.length),
        layer: 'extracted',
        repository,
        discriminator: record.discriminator,
        ...(record.role === undefined ? {} : { role: record.role }),
        ...(record.span === undefined ? {} : { span: { ...record.span } }),
        provenance: { source: CONTRACTS_ROUTES_SOURCE, repository: { id: repository, commit }, ...(record.span === undefined ? {} : { place: { file: record.span.path, range: { startLine: record.span.lineStart, startColumn: 0, endLine: record.span.lineEnd, endColumn: 0, startByte: record.span.byteStart, endByte: record.span.byteEnd } } }) },
      },
    },
  };
}

/** The commit the evidence text names (`<repository>@<commit>:<path>`). */
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
    provenance: { source: CONTRACTS_ROUTES_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
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
    throw new Error(`the unit "${unit.id}" runs the contracts-routes stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/contracts-routes.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/contracts-routes.ts)`);
  }
}
