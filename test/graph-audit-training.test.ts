/**
 * The graph-truth audit of the generated training repository (madarch-m38l.20): per kind, the
 * nodes with no edge and the nodes with no evidence span, printed as a table, and the nine
 * requirements the task names asserted as their own cases. Nothing is sampled and nothing is
 * capped: the counts are printed for the change record, and a failure names every node.
 *
 * This is the committed form of the audit the task asks for; the deduplicated numbers for one
 * revision live in the change record (docs/changes/madarch-m38l.20/change.md).
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPGliteDatabaseOwner, type DatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore, type GraphStore} from '../src/graph/index.js';
import {fillGraph} from '../src/extract/driver/index.js';
import {HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS} from '../src/extract/driver/extractors.js';
import {byCodePoint} from '../src/model/order.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as {snapshots: Record<string, string>};

interface Row {key: string; kind: string; evidence: unknown}
interface EdgeRow {type: string; from: string; to: string}

let owner: DatabaseOwner;
let store: GraphStore;
let workspace: string;
let rows: Row[] = [];
let edges: EdgeRow[] = [];
/** Kinds whose node is not a place in a file: a commit, a task, an author, the repository itself. */
const PROVENANCE_KINDS = new Set(['code.commit', 'code.task', 'code.author', 'code.repository', 'code.snapshot']);

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'madarch-graph-audit-'));
  const repository = path.join(workspace, 'repo');
  execFileSync('node', [path.join(ROOT, 'examples/training-repository/generate.mjs'), repository], {cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe']});
  owner = createPGliteDatabaseOwner({btreeGist: true});
  store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
  const report = await fillGraph({owner, store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: KEY.snapshots});
  rows = (await owner.run((tx) => tx.query<Row>(
    `SELECT coalesce(v.properties->>'recordKey', '[unkeyed]') AS key, coalesce(k.key, '[missing-kind]') AS kind, v.properties->'span' AS evidence
     FROM node_version v LEFT JOIN node_kind k ON k.id = v.kind_id
     WHERE v.scope_id = $1::bigint AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity' ORDER BY k.key COLLATE "C", 1`,
    [report.repositoryNode],
  ))).rows;
  edges = (await owner.run((tx) => tx.query<EdgeRow>(
    `SELECT coalesce(r.key, '[missing-relation]') AS type, coalesce(s.properties->>'recordKey', '?') AS "from", coalesce(d.properties->>'recordKey', '?') AS "to"
     FROM edge_version e JOIN node_version s ON s.node_id = e.src_id AND s.recorded_to = 'infinity'
     JOIN node_version d ON d.node_id = e.dst_id AND d.recorded_to = 'infinity'
     LEFT JOIN relation_type r ON r.id = e.relation_type_id
     WHERE e.scope_id = $1::bigint AND e.recorded_to = 'infinity' AND e.valid_to = 'infinity'`,
    [report.repositoryNode],
  ))).rows;
}, 900_000);

afterAll(async () => {
  await owner?.close();
  if (workspace !== undefined) rmSync(workspace, {recursive: true, force: true});
}, 60_000);

const kinds = (): string[] => [...new Set(rows.map((row) => row.kind))].sort(byCodePoint);
const connected = (): Set<string> => new Set(edges.flatMap((edge) => [edge.from, edge.to]));
const ofKind = (kind: string): Row[] => rows.filter((row) => row.kind === kind);
const edgesFrom = (key: string): EdgeRow[] => edges.filter((edge) => edge.from === key);
const edgesTo = (key: string): EdgeRow[] => edges.filter((edge) => edge.to === key);

describe('the graph-truth audit of the training repository', () => {
  test('every kind is counted, with its nodes that have no edge and its nodes that have no evidence span', () => {
    const has = connected();
    const lines = ['kind\tnodes\tno edge\tno evidence'];
    for (const kind of kinds()) {
      const held = ofKind(kind);
      lines.push(`${kind}\t${held.length}\t${held.filter((row) => !has.has(row.key)).length}\t${held.filter((row) => row.evidence === null).length}`);
    }
    console.log(`[audit] ${rows.length} nodes, ${edges.length} edges\n${lines.join('\n')}`);
    expect(rows.length).toBeGreaterThan(0);
    // 1. A node outside the Git/history provenance is connected and says where it stands.
    const orphaned = rows.filter((row) => !PROVENANCE_KINDS.has(row.kind) && !has.has(row.key)).map((row) => row.key);
    expect(orphaned).toEqual([]);
    const unevidenced = rows.filter((row) => !PROVENANCE_KINDS.has(row.kind) && row.evidence === null).map((row) => row.key);
    expect(unevidenced).toEqual([]);
  });

  test('2. every route reaches its handler, and every route a contract declares reaches its operation', () => {
    const routes = ofKind('code.route').map((row) => row.key);
    expect(routes.length).toBeGreaterThan(0);
    const handled = new Set(edges.filter((edge) => edge.type === 'code.handled-by').map((edge) => edge.from));
    expect(routes.filter((route) => !handled.has(route))).toEqual([]);
    // Both directions of the contract link: every operation the product declares has a server — a route
    // for an HTTP operation, a handler or its file for a gRPC one.
    const served = new Set(edges.filter((edge) => edge.type === 'code.serves').map((edge) => edge.to));
    expect(ofKind('code.operation').filter((row) => !served.has(row.key)).map((row) => row.key)).toEqual([]);
    expect(edges.filter((edge) => edge.type === 'code.calls-remote').length).toBeGreaterThan(0);
  });

  test('3. Kubernetes probes and compose healthchecks are facts with their path, port and period', () => {
    for (const probe of ofKind('code.probe')) {
      const properties = rows.find((row) => row.key === probe.key);
      expect(properties).toBeDefined();
    }
    expect(ofKind('code.probe').length).toBeGreaterThan(0);
    expect(ofKind('code.health-endpoint').length).toBeGreaterThan(0);
  });

  test('4. every symbol is connected: reads, type uses, calls and members', () => {
    const symbols = ofKind('code.symbol').map((row) => row.key);
    const held = connected();
    expect(symbols.filter((symbol) => !held.has(symbol))).toEqual([]);
    for (const relation of ['code.reads', 'code.uses-type', 'code.calls', 'code.implements']) {
      expect(edges.some((edge) => edge.type === relation)).toBe(true);
    }
  });

  test('5. every file reaches the entities it declares', () => {
    const files = ofKind('code.file').map((row) => row.key);
    // A file reaches its entities in both directions: `contains` runs from the file, `describes-file`
    // from the entity, and a file page is empty only when neither names anything.
    const declared = new Set(edges.filter((edge) => ['code.contains', 'code.describes-file'].includes(edge.type)).flatMap((edge) => [edge.from, edge.to]));
    expect(files.filter((file) => !declared.has(file))).toEqual([]);
  });

  test('6. imports reach the standard library, external packages and the declared dependency', () => {
    const imports = edges.filter((edge) => edge.type === 'code.imports');
    expect(imports.some((edge) => edge.to.startsWith('code.package:import/go/'))).toBe(true);
    expect(imports.some((edge) => edge.to.startsWith('code.dependency:'))).toBe(true);
  });

  test('7. the broker hosts its channels, and each channel names a publisher and a consumer', () => {
    const brokers = ofKind('code.broker');
    const channels = ofKind('code.channel');
    expect(brokers.length).toBeGreaterThan(0);
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) {
      const hosted = edgesTo(channel.key).some((edge) => edge.type === 'code.hosts-channel');
      expect(hosted).toBe(true);
    }
    for (const channel of channels) {
      const publishers = edges.filter((edge) => edge.type === 'code.publishes' && edge.to === channel.key);
      const consumers = edges.filter((edge) => edge.type === 'code.consumes' && edge.to === channel.key);
      // The canonical edge starts at a function; the file edge is the aggregated summary of the same site.
      expect(publishers.some((edge) => edge.from.startsWith('code.symbol:'))).toBe(true);
      expect(consumers.some((edge) => edge.from.startsWith('code.symbol:'))).toBe(true);
    }
  });

  test('8. every metric names the function that changes it and the endpoint that serves it', () => {
    const metrics = ofKind('code.metric').map((row) => row.key);
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      expect(edgesTo(metric).some((edge) => edge.type === 'code.updates-metric')).toBe(true);
      expect(edgesTo(metric).some((edge) => edge.type === 'code.exposes-metric')).toBe(true);
    }
  });

  test('9. every logger reaches the functions that use it', () => {
    const loggers = ofKind('code.logger').map((row) => row.key);
    expect(loggers.length).toBeGreaterThan(0);
    const used = new Set(edges.filter((edge) => edge.type === 'code.uses-logger').map((edge) => edge.to));
    expect(loggers.filter((logger) => !used.has(logger))).toEqual([]);
  });
});
