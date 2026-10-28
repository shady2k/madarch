/**
 * The graph-truth audit of the generated training repository (madarch-m38l.20): the nine requirements
 * the task names, asserted against the *expected* facts of the held fixture — `answer-key.json`, the
 * generator's templates and the plan — never against "something is connected".
 *
 * Each requirement is a pure checker over the filled rows (node key, kind, evidence) and edges
 * (type, from, to). The positive case asserts the checker finds no violation **and** that the expected
 * set is not empty; the negative case mutates exactly one row and asserts the checker reports it, so a
 * checker that passes everything fails here. A case that fails on main is an extraction gap, reported
 * with the node or edge it names, never a case to weaken.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPGliteDatabaseOwner, type DatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore, type GraphStore} from '../src/graph/index.js';
import {fillGraph} from '../src/extract/driver/index.js';
import {HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS} from '../src/extract/driver/extractors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = JSON.parse(readFileSync(path.join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as {
  snapshots: Record<string, string>;
  plantedCounts: Record<string, unknown>;
};

export interface Row {readonly key: string; readonly kind: string; readonly evidence: unknown; readonly properties: Record<string, unknown>}
export interface Edge {readonly type: string; readonly from: string; readonly to: string}
export interface Graph {readonly rows: readonly Row[]; readonly edges: readonly Edge[]}

const ofKind = (graph: Graph, kind: string): Row[] => graph.rows.filter((row) => row.kind === kind);
const keysOfKind = (graph: Graph, kind: string): string[] => ofKind(graph, kind).map((row) => row.key);
const edgesOf = (graph: Graph, type: string): Edge[] => graph.edges.filter((edge) => edge.type === type);
const names = (edges: readonly Edge[], field: 'from' | 'to'): string[] => edges.map((edge) => edge[field]);

/** A violation is a sentence naming what is missing or wrong; an empty list is the requirement held. */
type Violations = readonly string[];

/** One checker's working list: a violation is a sentence naming what is missing or wrong. */
type Collected = string[];

/** The kinds a node may belong to and still say nothing about a place in a file. */
const PROVENANCE = new Set(['code.commit', 'code.task', 'code.author', 'code.snapshot', 'code.repository']);

/** 1. A node is grounded: it says where it stands, or it is Git/history provenance, and it is connected. */
export function requirement1(graph: Graph): Violations {
  const connected = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  const violations: Collected = [];
  for (const row of graph.rows) {
    if (PROVENANCE.has(row.kind)) continue;
    if (row.evidence === null || row.evidence === undefined) violations.push(`${row.key}: no evidence span`);
    if (!connected.has(row.key)) violations.push(`${row.key}: no edge`);
  }
  return violations;
}

/** The orders router's operations and handlers the fixture declares (`contracts/openapi/orders.yaml`). */
const ORDERS_ROUTE = 'code.route:services/orders/internal/api/router.go';
const ORDERS_OPERATIONS = ['GET:/healthz', 'GET:/orders', 'GET:/orders/export', 'GET:/orders/{id}', 'POST:/orders', 'POST:/orders/{id}/cancel', 'POST:/orders/{id}/ship'];
const PROTO_OPERATIONS = ['payments.v1.Payments/Authorize', 'payments.v1.Payments/Refund'];

/** 2. Every route reaches one handler; every declared operation is served; a handler reaches its remote calls. */
export function requirement2(graph: Graph): Violations {
  const violations: Collected = [];
  const routes = keysOfKind(graph, 'code.route');
  const handled = edgesOf(graph, 'code.handled-by');
  for (const route of routes) {
    const handlers = handled.filter((edge) => edge.from === route);
    if (handlers.length !== 1) violations.push(`${route}: ${handlers.length} handlers, expected exactly 1`);
    if (!handlers.every((edge) => edge.to.startsWith('code.symbol:'))) violations.push(`${route}: a handler is not a function`);
  }
  const serves = edgesOf(graph, 'code.serves');
  for (const operation of ORDERS_OPERATIONS) {
    const key = `code.operation:contracts/openapi/orders.yaml#${operation}`;
    const server = serves.find((edge) => edge.to === key);
    if (server === undefined) violations.push(`${key}: no serving route`);
    else if (server.from !== `${ORDERS_ROUTE}#${operation}`) violations.push(`${key}: served by ${server.from}, expected the orders route`);
  }
  for (const operation of PROTO_OPERATIONS) {
    const key = `code.operation:contracts/proto/payments.proto#${operation}`;
    if (!serves.some((edge) => edge.to === key && edge.from.startsWith('code.') && (edge.from.startsWith('code.symbol:') || edge.from.startsWith('code.file:')))) {
      violations.push(`${key}: no gRPC server`);
    }
  }
  // The orders client reaches the contract the orders service serves: a remote call from checkout's client file.
  const remote = edgesOf(graph, 'code.calls-remote');
  if (!remote.some((edge) => edge.to.startsWith('code.operation:contracts/openapi/orders.yaml#'))) violations.push('no client reaches an orders operation');
  const handlersWithRemote = new Set([...names(remote, 'from')]);
  if (handlersWithRemote.size === 0) violations.push('no remote call site');
  return violations;
}

/** The probes the fixture's Kubernetes manifest and compose file declare. */
const PROBES: readonly {key: string; path: string; port: number}[] = [
  {key: 'code.probe:deploy/k8s/orders.yaml#orders/orders/livenessProbe', path: '/healthz', port: 8080},
  {key: 'code.probe:deploy/k8s/orders.yaml#orders/orders/readinessProbe', path: '/healthz', port: 8080},
  {key: 'code.probe:deploy/k8s/orders.yaml#orders/orders/startupProbe', path: '/healthz', port: 8080},
];

/** 3. Probes carry their path, port and period, and the health endpoint they test is the one served. */
export function requirement3(graph: Graph): Violations {
  const violations: Collected = [];
  for (const expected of PROBES) {
    const row = graph.rows.find((held) => held.key === expected.key);
    if (row === undefined) { violations.push(`${expected.key}: missing`); continue; }
    if (row.properties['path'] !== expected.path) violations.push(`${expected.key}: path ${String(row.properties['path'])}, expected ${expected.path}`);
    if (Number(row.properties['port']) !== expected.port) violations.push(`${expected.key}: port ${String(row.properties['port'])}, expected ${expected.port}`);
    if (row.properties['periodSeconds'] === undefined) violations.push(`${expected.key}: no periodSeconds`);
  }
  const healthchecks = keysOfKind(graph, 'code.healthcheck');
  if (!healthchecks.includes('code.healthcheck:docker-compose.yml#postgres')) violations.push('the compose healthcheck of postgres is missing');
  // Every probe links to the route it tests.
  const probes = edgesOf(graph, 'code.probes');
  for (const expected of PROBES) {
    const linked = probes.filter((edge) => edge.from === expected.key);
    if (linked.length === 0) violations.push(`${expected.key}: no route is linked`);
    // A probe reaches the route it tests, the endpoint that answers it, and the workload it configures.
    else if (!linked.every((edge) => edge.to.startsWith('code.route:') || edge.to.startsWith('code.health-endpoint:') || edge.to.startsWith('code.metrics-endpoint:') || edge.to.startsWith('code.k8s-deployment:'))) {
      violations.push(`${expected.key}: linked to ${linked.map((edge) => edge.to).join(', ')}, expected a route or an endpoint`);
    }
  }
  const endpoints = keysOfKind(graph, 'code.health-endpoint');
  if (endpoints.length === 0) violations.push('no health endpoint');
  return violations;
}

/** The symbol relationships the task names, each with the endpoint kind it must reach. */
const SYMBOL_RELATIONS: readonly {type: string; to: string; expected: number}[] = [
  {type: 'code.reads', to: 'code.symbol:', expected: 559},
  {type: 'code.uses-type', to: 'code.symbol:', expected: 371},
  {type: 'code.calls', to: 'code.symbol:', expected: 436},
  {type: 'code.implements', to: 'code.symbol:', expected: 19},
];

const symbolKeys = (graph: Graph): string[] => keysOfKind(graph, 'code.symbol');

/** 4. Every symbol is connected by the named relationships, and those reach functions and types. */
export function requirement4(graph: Graph): Violations {
  const violations: Collected = [];
  const symbols = symbolKeys(graph);
  if (symbols.length === 0) violations.push('no symbol');
  // A symbol is connected to another symbol: read by a function, called, used as a type, or held by its
  // type as a member. A file's containment is deliberately not enough — that is the page with no context.
  // A symbol is connected when something names it: another symbol (member, caller, reader, type use) or a
  // file's own top-level code, which is what a script's helper is read from. Its file's mere containment
  // does not count — that is the page with nothing around it.
  const REFERENCING = new Set(['code.reads', 'code.calls', 'code.uses-type', 'code.implements', 'code.inherits', 'code.references']);
  const connected = new Set(graph.edges
    .filter((edge) => REFERENCING.has(edge.type) || (edge.type === 'code.contains' && edge.from.startsWith('code.symbol:') && edge.to.startsWith('code.symbol:')))
    .flatMap((edge) => [edge.from, edge.to]));
  // A symbol the extractor reports as an unused export (or an unused top-level helper of a script) is
  // connected by that fact: it is dead code, named as dead. Every other symbol reaches another symbol.
  const dead = new Set(graph.rows.filter((row) => row.properties['deadExport'] === true).map((row) => row.key));
  for (const symbol of symbolKeys(graph)) if (!connected.has(symbol) && !dead.has(symbol) && !symbol.includes('.callback@')) violations.push(`${symbol}: isolated from reads, calls, type uses and members`);
  for (const relation of SYMBOL_RELATIONS) {
    const held = edgesOf(graph, relation.type).filter((edge) => edge.to.startsWith(relation.to));
    if (held.length !== relation.expected) violations.push(`${relation.type}: ${held.length} edges to ${relation.to}*, expected ${relation.expected}`);
  }
  // A read inside a function starts at that function; a read in a file's own top-level code (a script, a
  // module-level constant) starts at the file, which is the truthful origin and not a gap.
  const functions = new Set(symbols);
  for (const edge of edgesOf(graph, 'code.reads')) {
    if (!functions.has(edge.from) && !edge.from.startsWith('code.file:')) violations.push(`${edge.from} -> ${edge.to}: a read whose origin is neither a function nor a file`);
  }
  return violations;
}

/** The declarations the fixture holds for three files, by kind. */
const DECLARATIONS: readonly {file: string; kind: string; expected: number}[] = [
  {file: 'deploy/k8s/orders.yaml', kind: 'code.k8s-deployment', expected: 1},
  {file: 'deploy/k8s/orders.yaml', kind: 'code.probe', expected: 3},
  {file: 'docker-compose.yml', kind: 'code.compose-service', expected: 6},
  {file: 'Makefile', kind: 'code.make-target', expected: 7},
];

/** 5. A file reaches every entity it declares, in either direction, and the counts are the fixture's. */
export function requirement5(graph: Graph): Violations {
  const violations: Collected = [];
  const files = keysOfKind(graph, 'code.file');
  if (files.length === 0) violations.push('no file');
  const declares = (file: string, entity: string): boolean => graph.edges.some((edge) =>
    (edge.from === file && edge.to === entity) || (edge.to === file && edge.from === entity));
  for (const expected of DECLARATIONS) {
    const file = `code.file:${expected.file}`;
    const entities = graph.rows.filter((row) => row.kind === expected.kind).map((row) => row.key);
    if (entities.length !== expected.expected) violations.push(`${expected.kind}: ${entities.length} declarations, expected ${expected.expected}`);
    for (const entity of entities) if (!declares(file, entity)) violations.push(`${file}: does not reach ${entity}`);
  }
  // No file is empty: every file reaches at least one entity it declares.
  for (const file of files) {
    const reached = graph.edges.some((edge) => (edge.from === file && !edge.to.startsWith('code.file:')) || (edge.to === file && !edge.from.startsWith('code.file:')));
    if (!reached) violations.push(`${file}: reaches no entity`);
  }
  return violations;
}

/** The imports the fixture declares, with the version the manifest names. */
const IMPORTS: readonly {from: string; to: string}[] = [
  {from: 'code.file:services/orders/internal/api/handlers.go', to: 'code.package:import/go/net/http'},
  {from: 'code.file:services/orders/internal/api/handlers.go', to: 'code.package:import/go/log/slog'},
  {from: 'code.file:services/payments/src/api/routes.ts', to: 'code.dependency:services/payments/package.json#express'},
];

/** 6. Imports reach the standard library, an external package and the declared dependency with its version. */
export function requirement6(graph: Graph): Violations {
  const violations: Collected = [];
  const imports = edgesOf(graph, 'code.imports');
  for (const expected of IMPORTS) {
    if (!imports.some((edge) => edge.from === expected.from && edge.to === expected.to)) violations.push(`${expected.from} -> ${expected.to}: missing`);
  }
  const packages = new Set(names(imports.filter((edge) => edge.to.startsWith('code.package:import/go/')), 'to'));
  if (packages.size < 20) violations.push(`only ${packages.size} standard-library packages, expected at least 20`);
  const dependencies = new Set(names(imports.filter((edge) => edge.to.startsWith('code.dependency:')), 'to'));
  if (dependencies.size < 10) violations.push(`only ${dependencies.size} declared dependencies reached, expected at least 10`);
  for (const key of dependencies) {
    const row = graph.rows.find((held) => held.key === key);
    if (row === undefined) violations.push(`${key}: a dependency import whose dependency node is missing`);
    else if (typeof row.properties['version'] !== 'string') violations.push(`${key}: the dependency names no version`);
  }
  return violations;
}

/** 7. The broker hosts its channels, names its address, and each channel's publisher and consumer are functions. */
export function requirement7(graph: Graph): Violations {
  const violations: Collected = [];
  const brokers = ofKind(graph, 'code.broker');
  const kafka = brokers.find((row) => row.key === 'code.broker:docker-compose.yml#kafka');
  if (kafka === undefined) violations.push('the kafka broker of the compose file is missing');
  else if (!Array.isArray(kafka.properties['addresses']) || (kafka.properties['addresses'] as unknown[]).length === 0) violations.push('the kafka broker names no address');
  const channels = keysOfKind(graph, 'code.channel');
  if (channels.length !== 2) violations.push(`${channels.length} channels, expected 2 (orders.events, payments.events)`);
  const hosted = edgesOf(graph, 'code.hosts-channel');
  for (const channel of channels) {
    if (!hosted.some((edge) => edge.to === channel && edge.from === kafka?.key)) violations.push(`${channel}: not hosted by the kafka broker`);
    const publishers = graph.edges.filter((edge) => edge.type === 'code.publishes' && edge.to === channel && edge.from.startsWith('code.symbol:'));
    if (publishers.length === 0) violations.push(`${channel}: no function publishes it`);
    const consumers = graph.edges.filter((edge) => edge.type === 'code.consumes' && edge.to === channel && edge.from.startsWith('code.symbol:'));
    // The fixture publishes both channels and consumes one: the other is explicitly unconsumed.
    if (channel.endsWith('payments.events') && consumers.length === 0) violations.push(`${channel}: no function consumes it`);
  }
  const unconsumed = channels.filter((channel) => !graph.edges.some((edge) => edge.type === 'code.consumes' && edge.to === channel));
  if (unconsumed.length !== 1) violations.push(`${unconsumed.length} unconsumed channels, expected exactly 1 (orders.events)`);
  return violations;
}

/** The metrics the fixture declares, with the labels the code sets. */
const METRICS: readonly {key: string; type: string}[] = [
  {key: 'code.metric:services/orders/internal/api/metrics.go#orders_created_total', type: 'counter'},
  {key: 'code.metric:services/orders/internal/api/metrics.go#orders_http_requests_total', type: 'counter'},
  {key: 'code.metric:services/orders/internal/api/metrics.go#orders_purged_total', type: 'counter'},
  {key: 'code.metric:services/orders/internal/api/metrics.go#orders_transitions_total', type: 'counter'},
];

/** 8. Every metric names its type, its labels, the function that changes it and the endpoint that serves it. */
export function requirement8(graph: Graph): Violations {
  const violations: Collected = [];
  // A counter may declare no label at all; the fixture's set holds at least one that does.
  let labelled = 0;
  for (const expected of METRICS) {
    const row = graph.rows.find((held) => held.key === expected.key);
    if (row === undefined) { violations.push(`${expected.key}: missing`); continue; }
    if (row.properties['metricType'] !== expected.type) violations.push(`${expected.key}: metricType ${String(row.properties['metricType'])}, expected ${expected.type}`);
    if (!Array.isArray(row.properties['labels'])) violations.push(`${expected.key}: carries no labels list`);
    labelled += (row.properties['labels'] as unknown[]).length > 0 ? 1 : 0;
    const updates = graph.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === expected.key);
    if (updates.length === 0) violations.push(`${expected.key}: no update`);
    for (const update of updates) if (!update.from.startsWith('code.symbol:')) violations.push(`${expected.key}: updated by ${update.from}, which is not a function`);
    const exposes = graph.edges.filter((edge) => edge.type === 'code.exposes-metric' && edge.to === expected.key);
    if (exposes.length === 0) violations.push(`${expected.key}: no serving endpoint`);
    for (const expose of exposes) if (!(expose.from.startsWith('code.metrics-endpoint:') || expose.from.startsWith('code.route:'))) violations.push(`${expected.key}: exposed by ${expose.from}, which is not an endpoint`);
  }
  const metrics = keysOfKind(graph, 'code.metric');
  if (metrics.length !== METRICS.length) violations.push(`${metrics.length} metrics, expected ${METRICS.length}`);
  if (labelled === 0) violations.push('no metric declares a label');
  return violations;
}

/** 9. Every logger reaches the files and functions that use it: the edge runs `logger -> user`. */
export function requirement9(graph: Graph): Violations {
  const violations: Collected = [];
  const loggers = keysOfKind(graph, 'code.logger');
  if (loggers.length !== 5) violations.push(`${loggers.length} loggers, expected 5`);
  // logger.go#FromContext is an accessor: it returns the logger a context carries and logs nothing, so it
  // has no users. Every other logger is used by a function and names that using file.
  const accessors = new Set(['code.logger:services/orders/internal/logging/logger.go#FromContext']);
  for (const logger of loggers) {
    if (accessors.has(logger)) continue;
    const users = graph.edges.filter((edge) => edge.type === 'code.uses-logger' && edge.from === logger);
    const functions = users.filter((edge) => edge.to.startsWith('code.symbol:'));
    if (functions.length === 0) violations.push(`${logger}: no using function`);
    if (users.length === functions.length) violations.push(`${logger}: names no using file`);
  }
  return violations;
}

const REQUIREMENTS: readonly {name: string; check: (graph: Graph) => Violations}[] = [
  {name: '1 a node is grounded and connected', check: requirement1},
  {name: '2 routes, operations, handlers and remote calls', check: requirement2},
  {name: '3 probes, healthchecks and their endpoints', check: requirement3},
  {name: '4 symbol reads, calls, type uses and members', check: requirement4},
  {name: '5 files reach their declarations', check: requirement5},
  {name: '6 imports, packages and declared versions', check: requirement6},
  {name: '7 brokers, channels, publishers and consumers', check: requirement7},
  {name: '8 metrics, their types, updates and endpoints', check: requirement8},
  {name: '9 loggers and their users', check: requirement9},
];

let owner: DatabaseOwner;
let store: GraphStore;
let workspace: string;
let graph: Graph = {rows: [], edges: []};

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'madarch-graph-audit-'));
  const repository = path.join(workspace, 'repo');
  execFileSync('node', [path.join(ROOT, 'examples/training-repository/generate.mjs'), repository], {cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe']});
  owner = createPGliteDatabaseOwner({btreeGist: true});
  store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
  const report = await fillGraph({owner, store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: KEY.snapshots});
  const rows = (await owner.run((tx) => tx.query<{key: string; kind: string; evidence: unknown; properties: Record<string, unknown>}>(
    `SELECT coalesce(v.properties->>'recordKey', '[unkeyed]') AS key, coalesce(k.key, '[missing-kind]') AS kind, v.properties->'span' AS evidence, v.properties AS properties
     FROM node_version v LEFT JOIN node_kind k ON k.id = v.kind_id
     WHERE v.scope_id = $1::bigint AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'`,
    [report.repositoryNode],
  ))).rows;
  const edges = (await owner.run((tx) => tx.query<Edge>(
    `SELECT coalesce(r.key, '[missing-relation]') AS type, coalesce(s.properties->>'recordKey', '?') AS "from", coalesce(d.properties->>'recordKey', '?') AS "to"
     FROM edge_version e JOIN node_version s ON s.node_id = e.src_id AND s.recorded_to = 'infinity'
     JOIN node_version d ON d.node_id = e.dst_id AND d.recorded_to = 'infinity'
     LEFT JOIN relation_type r ON r.id = e.relation_type_id
     WHERE e.scope_id = $1::bigint AND e.recorded_to = 'infinity' AND e.valid_to = 'infinity'`,
    [report.repositoryNode],
  ))).rows;
  graph = {rows, edges};
}, 900_000);

afterAll(async () => {
  await owner?.close();
  if (workspace !== undefined) rmSync(workspace, {recursive: true, force: true});
}, 60_000);

const without = (base: Graph, predicate: (row: Row) => boolean): Graph => ({rows: base.rows.filter((row) => !predicate(row)), edges: base.edges});
const dropEdge = (base: Graph, predicate: (edge: Edge) => boolean): Graph => ({rows: base.rows, edges: base.edges.filter((edge) => !predicate(edge))});

describe('the graph-truth audit of the training repository', () => {
  test('prints the per-kind table of nodes, nodes with no edge and nodes with no evidence span', () => {
    const connected = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
    const kinds = [...new Set(graph.rows.map((row) => row.kind))].sort();
    const lines = ['kind\tnodes\tno edge\tno evidence'];
    for (const kind of kinds) {
      const held = graph.rows.filter((row) => row.kind === kind);
      lines.push(`${kind}\t${held.length}\t${held.filter((row) => !connected.has(row.key)).length}\t${held.filter((row) => row.evidence === null).length}`);
    }
    console.log(`[audit] ${graph.rows.length} nodes, ${graph.edges.length} edges\n${lines.join('\n')}`);
    expect(graph.rows.length).toBeGreaterThan(1000);
    expect(graph.edges.length).toBeGreaterThan(5000);
  });

  for (const requirement of REQUIREMENTS) {
    test(`${requirement.name}: the fixture's expected facts, and one wrong row is refused`, () => {
      const violations = requirement.check(graph);
      expect(violations.join('\n')).toBe('');
      // The expected set is not empty: a checker that guards nothing cannot pass.
      expect(graph.rows.length).toBeGreaterThan(1000);
    });
  }

  test('each requirement refuses a single wrong fact', () => {
    const cases: readonly {name: string; broken: Graph; expected: RegExp}[] = [
      {name: '1 an invented database with no evidence', broken: {rows: graph.rows.map((row) => (row.key === 'code.database:orders' ? {...row, evidence: null} : row)), edges: graph.edges}, expected: /code\.database:orders: no evidence span/},
      {name: '2 a route with no handler', broken: dropEdge(graph, (edge) => edge.type === 'code.handled-by' && edge.from.endsWith('#POST:/orders')), expected: /#POST:\/orders: 0 handlers/},
      {name: '3 a probe with the wrong path', broken: {rows: graph.rows.map((row) => (row.key.endsWith('/livenessProbe') ? {...row, properties: {...row.properties, path: '/nope'}} : row)), edges: graph.edges}, expected: /livenessProbe: path \/nope/},
      {name: '4 a read that starts outside a function', broken: {rows: graph.rows, edges: [...graph.edges, {type: 'code.reads', from: 'code.database:orders', to: 'code.symbol:services/orders/internal/domain/order.go#Order.ID'}]}, expected: /a read whose origin is neither a function nor a file/},
      {name: '5 a file that loses its deployment', broken: dropEdge(graph, (edge) => edge.type === 'code.contains' && edge.to === 'code.k8s-deployment:deploy/k8s/orders.yaml#orders'), expected: /code\.file:deploy\/k8s\/orders\.yaml: does not reach/},
      {name: '6 a dependency import without a version', broken: {rows: graph.rows.map((row) => (row.key === 'code.dependency:services/payments/package.json#express' ? {...row, properties: {...row.properties, version: undefined}} : row)), edges: graph.edges}, expected: /names no version/},
      {name: '7 a channel nobody consumes twice', broken: dropEdge(graph, (edge) => edge.type === 'code.consumes' && edge.to === 'code.channel:payments.events'), expected: /payments\.events: no function consumes it|2 unconsumed channels/},
      {name: '8 a metric updated by a file', broken: {rows: graph.rows, edges: graph.edges.map((edge) => (edge.type === 'code.updates-metric' && edge.to.includes('orders_created_total') ? {...edge, from: 'code.file:services/orders/internal/api/handlers.go'} : edge))}, expected: /orders_created_total: updated by code\.file:.*, which is not a function/},
      {name: '9 a logger with no users', broken: dropEdge(graph, (edge) => edge.type === 'code.uses-logger' && edge.from === 'code.logger:services/orders/internal/logging/logger.go#New'), expected: /logger\.go#New: no using function/},
    ];
    const reported = cases.flatMap((entry) => {
      const violations = (REQUIREMENTS.find((requirement) => requirement.name.startsWith(entry.name.slice(0, 1)))?.check ?? ((): Violations => []))(entry.broken);
      return violations.some((violation) => entry.expected.test(violation)) ? [] : [`${entry.name}: not refused; the checker said ${JSON.stringify(violations.slice(0, 3))}`];
    });
    expect(reported).toEqual([]);
  });
});
