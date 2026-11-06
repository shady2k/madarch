/**
 * The data model on the generated training repository (madarch-8bdc.2.4): the
 * records the extract driver's data-model reading publishes, against the records
 * the fill's static stages publish for the same tree, sorted by code point and
 * compared one by one. This is the port's goal: the stages must publish the same
 * records the driver published, and every difference is named by its kind and
 * its key.
 *
 * **How a record is compared.** A node is its kind, its key and the properties
 * the driver publishes; an edge is its relation, its two ends, its
 * discriminator and those properties. The graph's own bookkeeping is not part of
 * a record (`recordKey`, `factKind`, `layer`, `status`, `provenance`,
 * `repository`), and neither is a place the graph holds only as provenance: a
 * node's place is compared as its path and its line span, and an edge's place is
 * not compared at all, because the graph holds an edge's position only for a
 * positioned relation and no relation of this reading is positioned. The driver's
 * `code.symbol:<path>#<name>` and `code.file:<path>` keys name nodes the syntax
 * and snapshot stages publish under their own fact ids; the comparison maps them
 * through the global name and the path those nodes carry.
 *
 * **The list that may only shrink.** `EXPECTED_REMAINING` names the record
 * families the port has not reached yet. The test compares the families that
 * still differ with that list exactly: a family that appears without being
 * listed fails (the port may not add a difference), and a listed family that no
 * longer differs fails too (the list is stale and must shrink).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { extractDataModel } from '../src/extract/data-model/extract.js';
import { createFillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type EdgeEntry, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { DATA_MODEL_AGGREGATE_STAGE_ID, DATA_MODEL_NODE_KINDS, DATA_MODEL_RELATIONS, DATA_MODEL_STAGE_ID } from '../src/fill/stages/data-model.js';

const GENERATOR = fileURLToPath(new URL('../examples/training-repository/generate.mjs', import.meta.url));
const REPOSITORY = 'training';
const PRODUCT = 'training-shop';
const PRODUCERS = [`fill.${DATA_MODEL_STAGE_ID}`, `fill.${DATA_MODEL_AGGREGATE_STAGE_ID}`];

/** The families the port has not reached yet, by the record's own kind or relation: it may only shrink. */
const EXPECTED_REMAINING: readonly string[] = [];

/** The node kinds the comparison compares: the reading's own, and the two it links to another stage's nodes. */
const COMPARED_KINDS: readonly string[] = [...DATA_MODEL_NODE_KINDS, 'code.symbol', 'code.file'];
/** The relations the comparison compares. */
const COMPARED_RELATIONS: readonly string[] = [...DATA_MODEL_RELATIONS];

/** The graph's bookkeeping, which is not part of a record the driver publishes. */
const BOOKKEEPING: readonly string[] = ['recordKey', 'factKind', 'layer', 'status', 'provenance', 'repository'];

/**
 * The keys the port adds to a record, by kind: what the stage's own bounded
 * reads need to find the record again (a database's folder, a table's name, a
 * migration's series), which the extract driver never needed because it held the
 * whole tree in one object. Every other key a record carries is the driver's
 * own, and the comparison compares it. The list is a ceiling: a key that is not
 * named here is a difference, and a key in it may be absent where the record has
 * nothing to say (`foreignKey` stands only on a column a foreign key names).
 */
const GRAPH_ONLY_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  'code.column': ['database', 'databaseFolder', 'foreignKey', 'name', 'table'],
  'code.index': ['database', 'name', 'table'],
  'code.migration': ['database', 'databaseFolder', 'prisma'],
  'code.table': ['databaseFolder', 'name'],
};

/** One record as the comparison holds it: its family, its identity and the properties it publishes. */
interface ComparedRecord {
  readonly family: string;
  readonly id: string;
  readonly properties: string;
  /** The port's own keys the record carries, sorted, as a text the comparison checks against `GRAPH_ONLY_PROPERTIES`. */
  readonly graphOnly: string;
  readonly place?: string;
}

let root = '';
let owner: DatabaseOwner | undefined;
let service: ReturnType<typeof createFillOrchestratorService> | undefined;
let fill: StagesFill | undefined;
let store: GraphStore | undefined;
let first: FillRunResult | undefined;
let driverNodes: readonly ComparedRecord[] = [];
let driverEdges: readonly ComparedRecord[] = [];
let driverGaps: readonly string[] = [];
let fillGaps: readonly string[] = [];
let failures: readonly string[] = [];
let fillNodes: readonly ComparedRecord[] = [];
let fillEdges: readonly ComparedRecord[] = [];
let symbolKeys = new Map<string, string>();
let fileKeys = new Map<string, string>();
/** The fill's symbol nodes by the file they stand in, with the byte span each one's place gives. */
let fillSymbolSpans = new Map<string, { readonly startByte: number; readonly endByte: number; readonly key: string }[]>();
/** The span the driver's own record of a symbol stands at, by the driver's key. */
let driverSymbolSpans = new Map<string, { readonly path: string; readonly startByte: number; readonly endByte: number }>();

/** A path's files, the repository's own walk: no `.git`, sorted by code point. */
function walk(folder: string, prefix = ''): string[] {
  return readdirSync(join(folder, prefix)).flatMap((name) => {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(join(folder, relative)).isDirectory()) return name === '.git' ? [] : walk(folder, relative);
    return [relative];
  }).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** A JSON value's canonical text: object keys sorted, so two equal values compare equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const held = value as Record<string, unknown>;
  return `{${Object.keys(held).sort().map((key) => `${JSON.stringify(key)}:${canonical(held[key])}`).join(',')}}`;
}

/** The kind a family names: `node:code.table` and `edge:code.holds` name `code.table` and `code.holds`. */
function kindOf(family: string): string {
  return family.slice(family.indexOf(':') + 1);
}

/** The port's own keys a record of one kind carries, sorted: what `GRAPH_ONLY_PROPERTIES` names for it. */
function graphOnlyOf(family: string, properties: unknown): string {
  const held = properties !== null && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, unknown> : {};
  const named = GRAPH_ONLY_PROPERTIES[kindOf(family)] ?? [];
  return Object.keys(held).filter((key) => named.includes(key)).sort().join(',');
}

/** The properties a record publishes with the port's own keys left out: what both readings must agree on. */
function driverProperties(family: string, properties: unknown): string {
  const held = properties !== null && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, unknown> : {};
  const named = GRAPH_ONLY_PROPERTIES[kindOf(family)] ?? [];
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(held).sort()) if (!BOOKKEEPING.includes(key) && !named.includes(key)) kept[key] = held[key];
  return canonical(kept);
}

/** A node's place, with the bytes the syntax stage counts, or `undefined` where it names none. */
function nodePlaceOf(properties: unknown): { readonly file: string; readonly startByte: number; readonly endByte: number } | undefined {
  const held = properties !== null && typeof properties === 'object' ? properties as Record<string, unknown> : {};
  const provenance = held['provenance'] !== null && typeof held['provenance'] === 'object' ? held['provenance'] as Record<string, unknown> : undefined;
  const place = provenance?.['place'] !== null && typeof provenance?.['place'] === 'object' ? provenance['place'] as Record<string, unknown> : undefined;
  const range = place?.['range'] !== null && typeof place?.['range'] === 'object' ? place['range'] as Record<string, unknown> : undefined;
  if (place === undefined || range === undefined) return undefined;
  if (typeof place['file'] !== 'string' || typeof range['startByte'] !== 'number' || typeof range['endByte'] !== 'number') return undefined;
  return { file: place['file'], startByte: range['startByte'], endByte: range['endByte'] };
}

/** A node's place as the comparison holds it: the path and the lines, never a column the driver does not name. */
function nodePlace(properties: unknown): string | undefined {
  const held = properties !== null && typeof properties === 'object' ? properties as Record<string, unknown> : {};
  const provenance = held['provenance'] !== null && typeof held['provenance'] === 'object' ? held['provenance'] as Record<string, unknown> : undefined;
  const place = provenance?.['place'] !== null && typeof provenance?.['place'] === 'object' ? provenance['place'] as Record<string, unknown> : undefined;
  const range = place?.['range'] !== null && typeof place?.['range'] === 'object' ? place['range'] as Record<string, unknown> : undefined;
  if (place === undefined || range === undefined) return undefined;
  return `${String(place['file'])}:${String(range['startLine'])}-${String(range['endLine'])}`;
}

/** The driver's span as the comparison holds it: the path and the lines. */
function spanPlace(span: { readonly path: string; readonly lineStart: number; readonly lineEnd: number } | undefined): string | undefined {
  return span === undefined ? undefined : `${span.path}:${span.lineStart}-${span.lineEnd}`;
}

/** A driver node's identity: its kind and the key the fill would name the same node by. */
function driverNodeId(kind: string, key: string): string {
  return `${kind} ${key}`;
}

/**
 * The fill's record of one of the driver's symbols: the syntax stage's node the declaration stands
 * in. Two lookups, in this order — the global name the syntax stage gives a declared symbol, then
 * the innermost declared symbol whose place holds the driver's span. The second is what maps the
 * driver's synthesized closure name (`X.callback@<line>:<byte>`, a key built from a line and a byte
 * offset, not a declared name) onto the method that declares the closure: the same declaration, one
 * record in the fill. `collapsedDriverSymbols` counts exactly these.
 */
function fillSymbolKeyOf(key: string): string {
  const rest = key.slice('code.symbol:'.length);
  const named = symbolKeys.get(`${REPOSITORY}:${rest}`);
  if (named !== undefined) return named;
  const span = driverSymbolSpans.get(key);
  if (span === undefined) return key;
  const enclosing = (fillSymbolSpans.get(span.path) ?? [])
    .filter((held) => held.startByte <= span.startByte && span.endByte <= held.endByte)
    .sort((left, right) => (left.endByte - left.startByte) - (right.endByte - right.startByte) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return enclosing[0]?.key ?? key;
}

/** The driver's symbol keys the fill names by another declaration's key: the closures the fill names by their method. */
function collapsedDriverSymbols(): readonly string[] {
  return [...driverSymbolSpans.keys()]
    .filter((key) => symbolKeys.get(`${REPOSITORY}:${key.slice('code.symbol:'.length)}`) === undefined)
    .sort();
}

/** The fill node a driver end names, by the global name a symbol carries or the path a file carries. */
function fillEndOf(key: string): string {
  if (key.startsWith('code.symbol:')) return fillSymbolKeyOf(key);
  if (key.startsWith('code.file:')) {
    const found = fileKeys.get(key.slice('code.file:'.length));
    return found === undefined ? key : found;
  }
  return key;
}

/** Every node of one kind the graph holds for the repository, one page after another. */
async function nodesOfKind(kind: string): Promise<NodeVersionRow[]> {
  return await store!.readAll(async (page) => await store!.byProperty(kind, 'repository', REPOSITORY, page));
}

/** Every edge of one relation the graph holds for the repository, one page after another. */
async function edgesOfRelation(relation: string): Promise<EdgeEntry[]> {
  return await store!.readAll(async (page) => await store!.edgesByProperty(relation, 'repository', REPOSITORY, page));
}

/** A node version's record key, refused by name where it carries none. */
function recordKeyOf(node: NodeVersionRow): string {
  const held = node.properties !== null && typeof node.properties === 'object' ? node.properties as Record<string, unknown> : {};
  if (typeof held['recordKey'] !== 'string' || held['recordKey'] === '') {
    throw new Error(`the graph's node ${node.nodeId} (${node.kind}) carries no recordKey, so no record names it (test/fill-data-model-training.test.ts)`);
  }
  return held['recordKey'];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-data-model-training-'));
  const repository = join(root, REPOSITORY);
  execFileSync(process.execPath, [GENERATOR, repository], { stdio: ['ignore', 'pipe', 'pipe'] });
  const product = join(root, 'product');
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', REPOSITORY), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 5c2e8a52-9c3e-4f7a-8b21-6d2e9c0a5b41',
    `name: ${PRODUCT}`,
    'repos:',
    `  - name: ${REPOSITORY}`,
    '    url: file:///training',
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the product of the training repository');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    home: join(root, 'products'), owner, registry: fill.registry, wiring: () => fill!.wiring,
    clock: () => (at += 1_000), limits: { leaseMs: 86_400_000 }, maxPasses: 100_000,
  });
  store = createGraphStore(owner);
  const run = await service.run({ product: fill.product, runId: 'training-data-model' });
  if (!run.ok) throw new Error(`the fill was refused: ${run.code}: ${run.reason}`);
  first = run;

  // The driver's own reading of the same tree: its records and the gaps it names.
  const paths = walk(repository);
  const bytes = new Map(paths.map((path) => [path, new Uint8Array(readFileSync(join(repository, path)))]));
  const tree = { paths, read(path: string): Uint8Array {
    const held = bytes.get(path);
    if (held === undefined) throw new Error(`${repository}/${path} is no file of the generated repository`);
    return held;
  } };
  // The fill's own records: what the two stages published, read back by the repository they read.
  for (const node of await nodesOfKind('code.symbol')) {
    const held = node.properties as Record<string, unknown>;
    const key = recordKeyOf(node);
    if (typeof held['globalName'] === 'string') symbolKeys.set(held['globalName'], key);
    const place = nodePlaceOf(node.properties);
    if (place !== undefined) {
      const list = fillSymbolSpans.get(place.file) ?? [];
      list.push({ startByte: place.startByte, endByte: place.endByte, key });
      fillSymbolSpans.set(place.file, list);
    }
  }
  for (const node of await nodesOfKind('code.file')) {
    const held = node.properties as Record<string, unknown>;
    if (typeof held['path'] === 'string') fileKeys.set(held['path'], recordKeyOf(node));
  }
  const extraction = await extractDataModel(tree);
  for (const node of extraction.nodes) {
    if (node.kind !== 'code.symbol' || node.span === undefined) continue;
    driverSymbolSpans.set(node.key, { path: node.span.path, startByte: node.span.byteStart, endByte: node.span.byteEnd });
  }
  driverNodes = extraction.nodes
    .filter((node) => COMPARED_KINDS.includes(node.kind))
    .map((node) => {
      const family = `node:${node.kind}`;
      const linked = node.kind === 'code.symbol' || node.kind === 'code.file';
      // A symbol's and a file's record is the syntax and snapshot stage's node, so the driver's key
      // is mapped to the key the fill holds it under (see `fillEndOf`).
      const id = driverNodeId(node.kind, linked ? fillEndOf(node.key) : node.key);
      return { family, id, properties: linked ? '{}' : driverProperties(family, node.properties), graphOnly: graphOnlyOf(family, node.properties), ...(spanPlace(node.span) === undefined ? {} : { place: spanPlace(node.span) }) };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  driverEdges = extraction.edges
    .filter((edge) => COMPARED_RELATIONS.includes(edge.type))
    // The driver's catch-all containment re-cites every positioned node in its file, its symbols
    // included: a symbol's containment is the code reading's record, owned by the file pass and
    // published by the syntax stage, so the comparison holds the data model's own containment (a
    // migration, a table, a column, an index) and not the borrowed one.
    .filter((edge) => !(edge.type === 'code.contains' && edge.to.startsWith('code.symbol:')))
    .map((edge) => {
      const family = `edge:${edge.type}`;
      return {
        family,
        id: `${edge.type} ${fillEndOf(edge.from)} -> ${fillEndOf(edge.to)} disc=${edge.discriminator}`,
        properties: driverProperties(family, edge.properties),
        graphOnly: graphOnlyOf(family, edge.properties),
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  driverGaps = extraction.gaps.map((gap) => `${gap.path}: ${gap.reason}`).sort();

  // The fill's own records: what the two stages published, read back by the repository they read.
  // The symbol and file nodes the reading links to: only those the driver's own edges name, because
  // the syntax and snapshot stages publish every symbol and file of the tree where the reading names
  // the ones it reaches. A key the graph does not hold is the driver's own key, left as it stands.
  const linked = new Set<string>();
  for (const key of extraction.nodes.filter((node) => node.kind === 'code.symbol' || node.kind === 'code.file').map((node) => node.key)) linked.add(fillEndOf(key));
  const nodes: ComparedRecord[] = [];
  for (const kind of COMPARED_KINDS) {
    for (const node of await nodesOfKind(kind)) {
      const key = recordKeyOf(node);
      // The syntax and snapshot stages own the symbol and file nodes the reading links to; every
      // other kind is this reading's own.
      if (kind === 'code.symbol' || kind === 'code.file') {
        if (!linked.has(key)) continue;
      } else if (!PRODUCERS.includes(node.producer)) continue;
      const family = `node:${kind}`;
      const place = nodePlace(node.properties);
      nodes.push({ family, id: `${kind} ${key}`, properties: kind === 'code.symbol' || kind === 'code.file' ? '{}' : driverProperties(family, node.properties), graphOnly: graphOnlyOf(family, node.properties), ...(place === undefined ? {} : { place }) });
    }
  }
  fillNodes = nodes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const edges: ComparedRecord[] = [];
  for (const relation of COMPARED_RELATIONS) {
    for (const entry of await edgesOfRelation(relation)) {
      if (!PRODUCERS.includes(entry.edge.producer)) continue;
      const family = `edge:${relation}`;
      edges.push({
        family,
        id: `${relation} ${recordKeyOf(entry.src)} -> ${recordKeyOf(entry.dst)} disc=${entry.edge.discriminator}`,
        properties: driverProperties(family, entry.edge.properties),
        graphOnly: graphOnlyOf(family, entry.edge.properties),
      });
    }
  }
  fillEdges = edges.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // The gaps the port names: every per-file coverage's unread list, the same words the driver's
  // extraction gap carries as its reason.
  const gaps: string[] = [];
  for (const node of await nodesOfKind('code.coverage')) {
    if (!PRODUCERS.includes(node.producer)) continue;
    const held = node.properties as Record<string, unknown>;
    const unread = held['unread'];
    if (!Array.isArray(unread)) continue;
    for (const entry of unread) {
      if (entry === null || typeof entry !== 'object') continue;
      const what = (entry as Record<string, unknown>)['what'];
      if (typeof what === 'string') gaps.push(what);
    }
  }
  fillGaps = gaps.sort();
  // What the run's own events say about a unit that did not settle: the reason the unit failed,
  // so a red test names the failure and not only the unit.
  failures = await owner.transaction('snapshot', async (executor) => {
    const rows = await executor.query<{ summary: string }>("SELECT summary FROM fill_event WHERE kind = 'unit-failed' ORDER BY seq");
    return rows.rows.map((row) => row.summary);
  });
}, 1_800_000);

afterAll(async () => {
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** One difference between the driver's records and the fill's, named by its family and its record. */
interface Difference {
  readonly family: string;
  readonly id: string;
  readonly detail: string;
}

/** The differences between two sorted record sets, one per record identity and one per changed record. */
function differences(driver: readonly ComparedRecord[], actual: readonly ComparedRecord[]): Difference[] {
  const byId = new Map<string, ComparedRecord>();
  for (const record of driver) byId.set(record.id, record);
  const found: Difference[] = [];
  for (const record of actual) {
    const expected = byId.get(record.id);
    if (expected === undefined) {
      found.push({ family: record.family, id: record.id, detail: `the fill publishes it and the driver does not: ${record.properties}` });
      continue;
    }
    byId.delete(record.id);
    const named = (GRAPH_ONLY_PROPERTIES[kindOf(record.family)] ?? []).join(',');
    // The syntax and snapshot stages hold a symbol's and a file's record with their own properties;
    // the comparison pins the identity and the place, which is what the reading links to.
    if (record.family !== 'node:code.symbol' && record.family !== 'node:code.file' && expected.properties !== record.properties) found.push({ family: record.family, id: record.id, detail: `properties differ: driver ${expected.properties}; fill ${record.properties}` });
    // The syntax and snapshot stages hold a symbol's and a file's own place; the reading links to
    // their identity, and this comparison holds no place for them.
    else if (record.family !== 'node:code.symbol' && record.family !== 'node:code.file' && expected.place !== record.place) found.push({ family: record.family, id: record.id, detail: `place differs: driver ${expected.place ?? '(none)'}; fill ${record.place ?? '(none)'}` });
    else if (record.graphOnly.split(',').filter((key) => key !== '').some((key) => !named.split(',').includes(key))) found.push({ family: record.family, id: record.id, detail: `the port carries a key the comparison does not name on ${kindOf(record.family)}: ${JSON.stringify(record.graphOnly)} where the comparison names ${JSON.stringify(named)}` });
  }
  for (const expected of byId.values()) found.push({ family: expected.family, id: expected.id, detail: `the driver publishes it and the fill does not: ${expected.properties}${expected.place === undefined ? '' : ` at ${expected.place}`}${expected.graphOnly === '' ? '' : ` (the driver carries ${expected.graphOnly})`}` });
  return found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

describe('the data model on the training repository', () => {
  test('the fill finishes with every stage\'s units settled', () => {
    expect(first?.ok).toBe(true);
    if (first === undefined || !first.ok) return;
    expect({ state: first.state, settled: first.settled, failed: (first.units ?? []).filter((unit) => unit.state === 'failed').map((unit) => unit.unitId), failures })
      .toEqual({ state: 'succeeded', settled: true, failed: [], failures: [] });
  }, 1_800_000);

  test('the driver\'s nodes are the fill\'s nodes, record by record', () => {
    const found = differences(driverNodes, fillNodes);
    if (found.length > 0) console.error(found.map((difference) => `${difference.family} ${difference.id}: ${difference.detail}`).join('\n'));
    expect([...new Set(found.map((difference) => difference.family))].sort()).toEqual([...EXPECTED_REMAINING].filter((family) => family.startsWith('node:')).sort());
  }, 300_000);

  test('the driver\'s edges are the fill\'s edges, record by record', () => {
    const found = differences(driverEdges, fillEdges);
    if (found.length > 0) console.error(found.map((difference) => `${difference.family} ${difference.id}: ${difference.detail}`).join('\n'));
    expect([...new Set(found.map((difference) => difference.family))].sort()).toEqual([...EXPECTED_REMAINING].filter((family) => family.startsWith('edge:')).sort());
  }, 300_000);

  test('the driver\'s closure symbols stand in the method the fill names', () => {
    // The only driver symbol records that stand inside another driver symbol: a Go closure, whose
    // key the driver synthesizes from a line and a byte offset. The mapping names the method the
    // closure is declared in, and this pins exactly which records it collapses (change.md).
    expect(collapsedDriverSymbols()).toEqual([
      'code.symbol:services/orders/internal/store/order_repository.go#OrderRepository.Delete.callback@237:7918',
      'code.symbol:services/orders/internal/store/order_repository.go#OrderRepository.Save.callback@57:1448',
    ]);
  }, 60_000);

  test('the driver\'s gaps are the fill\'s gaps', () => {
    expect(fillGaps).toEqual(driverGaps);
  }, 60_000);
});
