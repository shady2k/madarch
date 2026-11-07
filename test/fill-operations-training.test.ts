/**
 * The operations stage against the extract driver on the generated training
 * repository (decision 0033, items 5, 14 and 15; madarch-8bdc.2.4): the
 * records the driver's operations reading publishes for one tree, and the
 * records this stage publishes one file at a time, compared record by record,
 * in code point order.
 *
 * **What is compared.** A node by its kind, its key, its label, its properties
 * and its span; an edge by its relation, the keys of its two ends, its
 * discriminator, its properties and its span. Both sets are reduced to that
 * shape and sorted by code point, and every difference names the kind (or
 * relation) and the key it stands at — a missing record, a record the stage
 * publishes that the driver does not, and a record both carry with a different
 * answer.
 *
 * **What is not compared.** A file's own node (`code.file`) is stage 0's: the
 * comparison asks that the graph holds a `code.file` node for every path the
 * driver's reading names a file at, by the path it carries. The stage's own
 * `code.coverage` records are its bookkeeping, not an operations record.
 *
 * **The remaining list.** The families the stage does not publish yet stand in
 * `REMAINING`, by the kind or relation the driver emits. A record of a kind the
 * list names must not stand in the graph, so porting a family means taking its
 * kinds off the list in the same commit; the list only shrinks, and the last
 * commit that empties it is the port's DONE WHEN.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { extractOperations } from '../src/extract/operations/index.js';
import type { ExtractedEdge, ExtractedNode, ExtractionGap, SourceSpan, TreeReader } from '../src/extract/records.js';
import { createFillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type EdgeEntry, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { FileText } from '../src/fill/stages/operations-records.js';
import { OPERATIONS_STAGE_ID, operationsFamilyOf, operationsRecordsOfFile } from '../src/fill/stages/operations.js';
import type { StaticGraphNode, StaticStageContext } from '../src/fill/stages/static-context.js';
import { createFileFactsCache } from '../src/fill/stages/file-facts.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

const GENERATOR = fileURLToPath(new URL('../examples/training-repository/generate.mjs', import.meta.url));
const REPOSITORY = 'training';
const PRODUCT = 'training-shop';

/**
 * The producers this comparison reads (`staticProducerOf`, `src/fill/stages/static-graph.ts`):
 * the per-file declarations of the operations stage, and the links its second stage makes
 * across files. A record either stage publishes is a record of the port.
 */
const STAGE_PRODUCERS: readonly string[] = ['fill.operations', 'fill.operations-links'];

/**
 * The families the stage does not publish yet, by the kind or relation the
 * driver emits: the port takes them off this list as each lands, and the list
 * only shrinks.
 */
/** The families the stage does not publish yet: none. The list stays so a family that has to wait is named here. */
const REMAINING: readonly string[] = [];

/** One record, reduced to the shape both readings are compared in. */
interface ComparedRecord {
  readonly kind: string;
  readonly key: string;
  /** The record's own text: everything the reading says about it, in one canonical spelling. */
  readonly text: string;
}

/** What one reading holds, as the comparison reads it: nodes and edges by their own texts, sorted by code point. */
interface Compared {
  readonly nodes: readonly ComparedRecord[];
  readonly edges: readonly ComparedRecord[];
  readonly gaps: readonly ExtractionGap[];
}

let root = '';
let owner: DatabaseOwner | undefined;
let service: ReturnType<typeof createFillOrchestratorService> | undefined;
let fill: StagesFill | undefined;
let store: GraphStore | undefined;
let first: FillRunResult | undefined;
let second: FillRunResult | undefined;
let driver: Compared | undefined;
/** The paths the driver's reading names a file at: the `code.file` records it made, in code point order. */
let driverFiles: readonly string[] = [];
let published: Compared | undefined;

/** The node properties a read answered, as a record. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** Every node of one kind the graph holds for the repository, one page after another. */
async function nodesOfKind(kind: string): Promise<readonly NodeVersionRow[]> {
  const rows: NodeVersionRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store!.byProperty(kind, 'repository', REPOSITORY, { limit: 1000, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** Every edge of one relation the graph holds for the repository, one page after another. */
async function edgesOfRelation(relation: string): Promise<readonly EdgeEntry[]> {
  const rows: EdgeEntry[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store!.edgesByProperty(relation, 'repository', REPOSITORY, { limit: 1000, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** A span as the comparison reads it, or none: the record cites no line. */
function spanText(span: SourceSpan | undefined): string {
  return span === undefined ? 'none' : `${span.path}@${String(span.byteStart)}-${String(span.byteEnd)}:${String(span.lineStart)}-${String(span.lineEnd)}`;
}

/** One value in the comparison's canonical spelling: object keys in code point order, arrays as they stand. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, held]) => [key, canonical(held)]));
  }
  return value;
}

/** The record text of one node: its kind, key, label, properties and span, as one canonical line. */
function nodeText(kind: string, key: string, label: string, properties: unknown, span: unknown): string {
  return `${kind} ${key} ${JSON.stringify(canonical({ label, properties, span }))}`;
}

/** One edge's record text: its relation, its ends' keys, its discriminator, its properties and its span. */
function edgeText(type: string, from: string, to: string, discriminator: string, properties: unknown, span: unknown): string {
  return `${type} ${from} -> ${to} ${JSON.stringify(canonical({ discriminator, properties, span }))}`;
}

/**
 * The graph's own identity of a fact the extract driver cites (decision 0033, item 7). The
 * driver names a fact by the place it was read at — `<path>:<start>:<end>:<what>` — and the fill
 * names the same fact `code.binding:<repository>:<path>@<start>:<end>:binding` or
 * `code.expression:<repository>:<path>@<start>:<end>:<what>`. A declaration and an export are
 * nodes of their own, so their identity is the graph's answer: the syntax stage's declaration
 * where one stands, and the code-facts stage's callable where no declaration names it (the two
 * keys one declaration carries are the driver's defect, recorded in the change). An id this
 * function cannot read is returned unchanged, and the comparison then names it as a difference.
 */
async function graphIdentityOfFact(id: string): Promise<string> {
  const symbol = /^code\.symbol:(.+)#([^#]+)$/.exec(id);
  if (symbol !== null) {
    const path = symbol[1]!;
    const name = symbol[2]!;
    const declared = await store!.byGlobalName(`${REPOSITORY}:${path}#${name}`, { limit: 8 });
    if (declared.rows.length === 1) return String(propertiesOf(declared.rows[0]!)['recordKey']);
    const callable = await store!.byProperty('code.callable', 'symbolKey', id, { limit: 8 });
    const mine = callable.rows.filter((row) => propertiesOf(row)['repository'] === REPOSITORY);
    return mine.length === 1 ? String(propertiesOf(mine[0]!)['recordKey']) : id;
  }
  if (id.startsWith('code.')) return id;
  // An export is the one fact the two readings spell by two ids: the driver names it by the
  // declaration's place (`path:start:end:export:name`), the fill's parse by the name's place
  // (`code.export:<repository>:<path>#<name>@<byte>`). No graph node carries either spelling
  // any more (madarch-8bdc.2.5), so both sides are written here as the file and the name.
  const exported = /^(.+):(\d+):(\d+):export:(.+)$/.exec(id);
  if (exported !== null) return `export:${exported[1]}#${exported[4]}`;
  const fact = /^(.+):(\d+):(\d+):(import|binding|[A-Za-z_][A-Za-z0-9_]*)$/.exec(id);
  if (fact === null) return id;
  const path = fact[1]!;
  const start = fact[2]!;
  const end = fact[3]!;
  const what = fact[4]!;
  return what === 'import' || what === 'binding'
    ? `code.binding:${REPOSITORY}:${path}@${start}:${end}:binding`
    : `code.expression:${REPOSITORY}:${path}@${start}:${end}:${what}`;
}

/** The fill's own spelling of an export fact, as the comparison names it: the file and the name. */
function exportSpelling(value: unknown): unknown {
  if (typeof value === 'string') {
    const held = /^code\.export:[^:]+:(.+)#([^@]+)@\d+$/.exec(value);
    return held === null ? value : `export:${held[1]}#${held[2]}`;
  }
  if (Array.isArray(value)) return value.map(exportSpelling);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = exportSpelling(item);
    return out;
  }
  return value;
}

/** One value with every fact id in it named the graph's way. */
async function graphIdentityOf(value: unknown): Promise<unknown> {
  if (typeof value === 'string') return await graphIdentityOfFact(value);
  if (Array.isArray(value)) return await Promise.all(value.map((item) => graphIdentityOf(item)));
  if (value !== null && typeof value === 'object') {
    const held: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) held[key] = await graphIdentityOf(item);
    return held;
  }
  return value;
}

/**
 * The driver's own answer, as the comparison reads it. A `code.symbol` node is the driver's second
 * node for a declaration the syntax stage publishes, so it is not compared (the change records the
 * two keys); its key is still mapped wherever a record ends at it. The containment edge into such a
 * node is the syntax stage's own record, not this reading's, so it is not compared either.
 */
async function comparedDriver(extraction: ReturnType<typeof extractOperations>): Promise<Compared> {
  const kindOf = new Map<string, string>(extraction.nodes.map((node: ExtractedNode) => [node.key, node.kind]));
  const nodes: ComparedRecord[] = [];
  for (const node of extraction.nodes) {
    if (node.kind === 'code.file' || node.kind === 'code.symbol' || REMAINING.includes(node.kind)) continue;
    const key = await graphIdentityOfFact(node.key);
    nodes.push({ kind: node.kind, key, text: nodeText(node.kind, key, node.label, await graphIdentityOf(node.properties), spanText(node.span)) });
  }
  // An edge of which one end is a record of a family the stage does not publish yet is not
  // compared: its end does not stand in the graph, and the edge cannot.
  const ported = (key: string): boolean => {
    const kind = kindOf.get(key);
    return kind === undefined || !REMAINING.includes(kind);
  };
  const edges: ComparedRecord[] = [];
  for (const edge of extraction.edges) {
    if (REMAINING.includes(edge.type) || !ported(edge.from) || !ported(edge.to)) continue;
    if (edge.type === 'code.contains' && kindOf.get(edge.to) === 'code.symbol') continue;
    const from = await graphIdentityOfFact(edge.from);
    const to = await graphIdentityOfFact(edge.to);
    edges.push({ kind: edge.type, key: `${from} -> ${to}`, text: edgeText(edge.type, from, to, edge.discriminator, await graphIdentityOf(edge.properties), spanText(edge.span)) });
  }
  const byText = (left: ComparedRecord, right: ComparedRecord): number => (leftText(left) < leftText(right) ? -1 : leftText(left) > leftText(right) ? 1 : 0);
  return { nodes: nodes.sort(byText), edges: edges.sort(byText), gaps: extraction.gaps };
}

/** What one compared record sorts and prints by: its kind and its key. */
function leftText(record: ComparedRecord): string {
  return `${record.kind}\u0000${record.key}`;
}

/** The kinds and relations the operations reading emits, by the names the driver gives them. */
async function comparePublished(): Promise<Compared> {
  const rows: NodeVersionRow[] = [];
  const kinds = new Set<string>();
  for (const node of driver?.nodes ?? []) kinds.add(node.kind);
  for (const node of driver?.edges ?? []) kinds.add(node.kind);
  for (const kind of [...kinds].sort()) {
    if (REMAINING.includes(kind)) continue;
    for (const row of await nodesOfKind(kind)) if (STAGE_PRODUCERS.includes(row.producer)) rows.push(row);
  }
  const nodes = rows.map((row) => {
    const held = propertiesOf(row);
    return { kind: row.kind, key: String(held['recordKey']), text: nodeText(row.kind, String(held['recordKey']), row.label, exportSpelling(held['record']), spanText(held['span'] as SourceSpan | undefined)) };
  });
  const edges: ComparedRecord[] = [];
  for (const relation of [...new Set((driver?.edges ?? []).map((edge) => edge.kind))].sort()) {
    if (REMAINING.includes(relation)) continue;
    for (const entry of await edgesOfRelation(relation)) {
      // The reading's own edges: another stage writes a relation of the same name (the data
      // model's containment), and this comparison holds what these two stages published.
      if (!STAGE_PRODUCERS.includes(entry.edge.producer)) continue;
      const held = propertiesOf(entry.edge);
      if (held['factKind'] !== relation.slice('code.'.length)) continue;
      const from = recordKeyOf(entry.src);
      const to = recordKeyOf(entry.dst);
      edges.push({ kind: relation, key: `${from} -> ${to}`, text: edgeText(relation, from, to, String(held['discriminator'] ?? ''), exportSpelling(held['record']), spanText(held['span'] as SourceSpan | undefined)) });
    }
  }
  return {
    nodes: nodes.sort((left, right) => (leftText(left) < leftText(right) ? -1 : leftText(left) > leftText(right) ? 1 : 0)),
    edges: edges.sort((left, right) => (leftText(left) < leftText(right) ? -1 : leftText(left) > leftText(right) ? 1 : 0)),
    gaps: [],
  };
}

/** The key a graph node's record carries: a stage's own record, or the path a file node stands for. */
function recordKeyOf(row: NodeVersionRow): string {
  const held = propertiesOf(row);
  // A file is named by its path: the driver's own `code.file:<path>` key, and stage 0's node
  // is the file the path names (its `recordKey` is the fact id, and the comparison reads the path).
  if (row.kind === 'code.file') return `code.file:${String(held['path'])}`;
  if (typeof held['recordKey'] === 'string') return held['recordKey'];
  return `graph:${row.nodeId}`;
}

/** The differences between the driver's reading and the stage's, each named by its kind and key. */
function differencesOf(expected: Compared, actual: Compared): string[] {
  const differences: string[] = [];
  const wantNodes = new Map(expected.nodes.map((node) => [leftText(node), node]));
  const haveNodes = new Map(actual.nodes.map((node) => [leftText(node), node]));
  for (const [key, node] of wantNodes) {
    const held = haveNodes.get(key);
    if (held === undefined) differences.push(`missing node ${node.kind} ${node.key}`);
    else if (held.text !== node.text) differences.push(`different node ${node.kind} ${node.key}:\n  driver: ${node.text}\n  stage:  ${held.text}`);
  }
  for (const [key, node] of haveNodes) if (!wantNodes.has(key)) differences.push(`unexpected node ${node.kind} ${node.key}: ${node.text}`);
  const wantEdges = new Map(expected.edges.map((edge) => [`${leftText(edge)}\u0000${edge.text}`, edge]));
  const haveEdges = new Map(actual.edges.map((edge) => [`${leftText(edge)}\u0000${edge.text}`, edge]));
  const haveEdgeKeys = new Map(actual.edges.map((edge) => [leftText(edge), edge]));
  const wantEdgeKeys = new Map(expected.edges.map((edge) => [leftText(edge), edge]));
  for (const [key, edge] of wantEdges) if (!haveEdges.has(key)) {
    const held = haveEdgeKeys.get(leftText(edge));
    differences.push(held === undefined ? `missing edge ${edge.kind} ${edge.key}` : `different edge ${edge.kind} ${edge.key}:\n  driver: ${edge.text}\n  stage:  ${held.text}`);
  }
  for (const [key, edge] of haveEdges) if (!wantEdges.has(key) && !wantEdgeKeys.has(leftText(edge))) differences.push(`unexpected edge ${edge.kind} ${edge.key}: ${edge.text}`);
  return differences.sort();
}


/** The repository's committed files, in code point order: the tree the driver reads. */
function committedFiles(repository: string): string[] {
  return execFileSync('git', ['-C', repository, 'ls-tree', '-r', 'HEAD', '--name-only'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path !== '')
    .sort();
}

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-operations-training-'));
  const repository = join(root, 'training');
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
    // The stages the operations reading stands on: stage 0's file nodes and the code facts a
    // unit's imports and listen addresses are read from. Every other stage is disabled, so this
    // case times the work it compares and nothing beside it.
    'fill:',
    '  stages:',
    ...['build-configuration', 'document-index', 'history', 'inventory', 'modules', 'semantic-resolution', 'state-machines', 'syntax'].flatMap((id) => [`    ${id}:`, '      enabled: false']),
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] }); };
  writeFirstFillWorkflow(product);
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
  const run = await service.run({ product: fill.product, runId: 'training-one' });
  if (!run.ok) throw new Error(`the first fill was refused: ${run.code}: ${run.reason}`);
  first = run;
  // A unit the stage could not publish is said first, with the reader's own words — the unit,
  // its stage and the file: the comparison below is worth nothing while a file of the stage
  // stands failed (decision 0005), and a state alone hides which unit it stands over.
  const failed = run.units.filter((unit) => unit.state === 'failed');
  if (failed.length > 0) {
    const { readProgress } = await import('../src/fill/orchestrator-store.js');
    const events = await readProgress(owner, 'training-one', {});
    const said = failed.map((unit) => {
      const refused = events.filter((event) => event.kind === 'unit-failed' && event.unitId === unit.unitId).at(-1);
      return `${unit.unitId} (stage ${unit.stageId}, ${String(unit.attempts)} attempt${unit.attempts === 1 ? '' : 's'}): ${refused?.summary ?? 'the run recorded no reason'}`;
    });
    throw new Error(`the first fill left ${String(failed.length)} unit(s) failed, in state ${run.state}:\n${said.join('\n')}`);
  }
  if (run.state !== 'succeeded') {
    throw new Error(`the first fill did not succeed: state ${run.state}, settled ${String(run.settled)}, stopped ${String(run.stoppedBecause)}, work ${String(run.work)}, passes ${String(run.passes)}`);
  }
  // The driver's own reading of the same tree, at the same commit.
  const paths = committedFiles(repository);
  const bytes = new Map<string, Uint8Array>(paths.map((path) => [path, new Uint8Array(readFileSync(join(repository, path)))]));
  const tree: TreeReader = {
    paths,
    read(path: string): Uint8Array {
      const held = bytes.get(path);
      if (held === undefined) throw new Error(`${repository}/${path}:1: ${path} is no committed file of the generated repository`);
      return held;
    },
  };
  const code = await extractCodeWithFacts(tree);
  const extraction = extractOperations(tree, code.extraction, code.facts);
  driver = await comparedDriver(extraction);
  driverFiles = [...new Set(extraction.nodes.filter((node) => node.kind === 'code.file').map((node) => String(node.properties['path'])))].sort();
  published = await comparePublished();
  const again = await service.run({ product: fill.product, runId: 'training-two' });
  if (!again.ok) throw new Error(`the second fill was refused: ${again.code}: ${again.reason}`);
  second = again;
}, 900_000);

afterAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

describe('the operations stage against the extract driver (training repository)', () => {
  test('the fill published, and the driver read the same tree', () => {
    expect({
      state: first?.state,
      settled: first?.settled,
      failed: (first?.units ?? []).filter((unit) => unit.state === 'failed').map((unit) => unit.unitId),
    }).toEqual({ state: 'succeeded', settled: true, failed: [] });
    expect(driver?.nodes.length ?? 0).toBeGreaterThan(100);
    expect(driver?.edges.length ?? 0).toBeGreaterThan(100);
    // The reading is not vacuous: the repository declares four services' manifests and
    // their lock files, four Dockerfiles, a Makefile and one workflow.
    const kinds = new Set((driver?.nodes ?? []).map((node) => node.kind));
    for (const kind of ['code.manifest', 'code.lockfile', 'code.dependency', 'code.dockerfile', 'code.make-target', 'code.ci-workflow']) expect(kinds.has(kind)).toBe(true);
  }, 900_000);

  test('every record the ported families publish answers the driver\'s record, and no other kind stands', () => {
    if (driver === undefined || published === undefined) throw new Error('the two readings were not made');
    // A kind the list names must not stand in the graph under this stage's producer: a
    // family taken off the list is compared, one still on it is not published at all.
    const publishedKinds = new Set([...published.nodes, ...published.edges].map((record) => record.kind));
    expect([...publishedKinds].filter((kind) => REMAINING.includes(kind))).toEqual([]);
    expect(differencesOf(driver, published)).toEqual([]);
  }, 900_000);

  test('every file the driver names stands as a file node of the graph, by its path', async () => {
    if (driver === undefined) throw new Error('the driver did not read the tree');
    const files = await nodesOfKind('code.file');
    const paths = new Set(files.filter((row) => !STAGE_PRODUCERS.includes(row.producer)).map((row) => String(propertiesOf(row)['path'])));
    expect(driverFiles.length).toBeGreaterThan(0);
    const missing = driverFiles.filter((path) => !paths.has(path));
    expect(missing).toEqual([]);
  }, 900_000);

  test('a second fill of the same commit writes nothing', () => {
    expect({ state: second?.state, settled: second?.settled }).toEqual({ state: 'succeeded', settled: true });
    const units = second?.units ?? [];
    const reused = second?.reused ?? [];
    expect(units.filter((unit) => !reused.includes(unit.unitId)).map((unit) => unit.unitId)).toEqual([]);
  }, 900_000);
});

describe('the plan\'s families, and one file\'s records read without a fill', () => {
  test('the family a path belongs to is the reading that reads it', () => {
    expect(operationsFamilyOf('services/orders/go.mod')).toBe('manifest');
    expect(operationsFamilyOf('services/orders/package-lock.json')).toBe('lockfile');
    expect(operationsFamilyOf('services/orders/Dockerfile')).toBe('dockerfile');
    expect(operationsFamilyOf('docker-compose.yml')).toBe('compose');
    expect(operationsFamilyOf('Makefile')).toBe('makefile');
    expect(operationsFamilyOf('.github/workflows/ci.yml')).toBe('workflow');
    expect(operationsFamilyOf('services/orders/internal/api/router.go')).toBe('code');
    expect(operationsFamilyOf('docs/adr/0001-broker.md')).toBeUndefined();
  }, 300_000);

  test('one manifest\'s records come from its own bytes, without a fill', async () => {
    const text = '{\n  "name": "shop",\n  "dependencies": { "express": "^4.21.2" },\n  "devDependencies": { "jest": "29.7.0" }\n}\n';
    const context = stubContext({ 'services/shop/package.json': text });
    const records = await operationsRecordsOfFile(context, REPOSITORY, 'services/shop/package.json', new FileText('services/shop/package.json', new TextEncoder().encode(text)));
    expect(records.gaps).toEqual([]);
    expect(records.nodes.map((node) => node.key)).toEqual([
      'code.dependency:services/shop/package.json#express',
      'code.dependency:services/shop/package.json#jest',
      'code.manifest:services/shop/package.json',
    ]);
    // The span of a dependency stands on the line its declaration is on; the manifest's on the file.
    expect(records.nodes.find((node) => node.key.endsWith('#express'))?.span?.lineStart).toBe(3);
    expect(records.edges.map((edge) => edge.type)).toEqual(['code.declares-dependency', 'code.declares-dependency']);
  }, 300_000);

  test('the fill planned this stage\'s units', () => {
    const units = (first?.units ?? []).filter((unit) => unit.stageId === OPERATIONS_STAGE_ID);
    expect(units.length).toBeGreaterThan(10);
    expect(units.every((unit) => unit.state === 'published')).toBe(true);
  }, 300_000);
});

/** A static context over one folder's files, with no graph: what a reader needs to read one file's bytes. */
function stubContext(files: Readonly<Record<string, string>>): StaticStageContext {
  const paths = Object.keys(files).sort();
  const bytes = new Map(paths.map((path) => [path, new TextEncoder().encode(files[path] ?? '')]));
  const source = {
    repository: REPOSITORY,
    commit: '0'.repeat(40),
    form: 'code' as const,
    source: { system: 'fixture', version: '1' },
    tree: '0'.repeat(40),
    fileCount: paths.length,
    byteCount: 0,
    entry: async (path: string) => bytes.has(path) ? { path, form: 'blob' as const, id: '0'.repeat(40) } : undefined,
    file: async (path: string) => bytes.has(path) ? { path, form: 'blob' as const, id: '0'.repeat(40), repository: REPOSITORY, commit: '0'.repeat(40), content: bytes.get(path)! } : undefined,
    holdsDirectory: async (path: string) => paths.some((held) => held.startsWith(`${path}/`)),
    filesUnder: async (path: string) => {
      const prefix = path === '' ? '' : `${path}/`;
      return paths.filter((held) => held.startsWith(prefix)).map((held) => ({ path: held, form: 'blob' as const, id: '0'.repeat(40) }));
    },
  };
  const empty = async (): Promise<readonly StaticGraphNode[]> => [];
  return {
    repository: source,
    fileFacts: createFileFactsCache(),
    byKey: empty,
    byGlobalName: empty,
    byProperty: async () => ({ rows: [], next: null }),
    edgesByProperty: async () => ({ rows: [], next: null }),
    neighbourhood: async () => ({ rows: [], next: null }),
  };
}
