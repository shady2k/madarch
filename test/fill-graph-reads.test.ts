/**
 * The bounded graph reads (madarch-tzte.20.3, decisions 0026 and 0027): the six
 * tools a unit reads the product graph through answer from the fill's fact store
 * within the caps 0026 fixes, an answer the cap cut carries a marker naming what
 * was cut, and every read a tool makes is recorded as the reading unit's
 * dependency — the query and its result membership, an empty answer included —
 * so a later publication that changes one of those memberships marks the unit
 * stale in the orchestrator's own sweep.
 *
 * Every expectation here is taken from the task, from decision 0026 and from
 * decision 0027, never from the module: the caps are 0026's numbers, the orders
 * are code point orders (`byCodePoint`), the truncation markers name how many
 * rows or lines were cut, and the staleness is the cause the sweep prints. The
 * graph is one the test publishes through the store's own sink
 * (`applyPublishedFacts`), the commits are ones the test makes with git, and
 * nothing here reads this checkout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { byCodePoint } from '../src/model/order.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { FACT_APPLICATION, applyPublishedFacts, createFactStoreSchema } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactEdgeKind, type FactProvenance } from '../src/fill/facts.js';
import {
  COVERAGE_GAP_LIMIT,
  COVERAGE_READ_SAMPLE,
  DEFAULT_GRAPH_READ_LIMITS,
  NEIGHBOR_EDGE_KINDS,
  callGraphRead,
  claimsAbout,
  coverage,
  createFactGraphReader,
  createGraphReadContext,
  describeScope,
  evidenceSpan,
  graphReadsOver,
  linesOf,
  neighbors,
  parseGraphRead,
  readText,
  references,
  type GraphRead,
  type GraphReadContext,
} from '../src/fill/graph-reads.js';
import {
  DEFAULT_ORCHESTRATOR_LIMITS,
  admitUnits,
  createOrchestrator,
  invalidateStaleUnits,
  planRun,
  startRun,
  workOnce,
  type FillOrchestrator,
} from '../src/fill/orchestrator.js';
import {
  createOrchestratorSchema,
  readUnitReads,
  type RunSnapshot,
  type UnitPlanRecord,
} from '../src/fill/orchestrator-store.js';
import { StageRegistry } from '../src/fill/registry.js';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { createFillStateSchema, createUnit, readUnit, readUnitGenerations } from '../src/fill/state-store.js';
import type { QueueService } from '../src/fill/queue.js';

const NOW = 1_700_000_000_000;
const REPOSITORY = 'acme-shop';
const COMMIT = 'a'.repeat(40);
const FILE = 'src/order.ts';
const SNAPSHOT: RunSnapshot = { repository: 'example.com/acme/shop', defaultBranch: 'main', commit: COMMIT, registryHash: 'sha256:registry' };

/** The from end a fixture edge names: what a read answers where the graph holds no such node. */
function startsOf(edge: Fact): string {
  return (edge.value as { readonly from: string }).from;
}

/** One provenance: a fact read out of a file of the fixture repository at the pinned commit. */
function provenance(file: string, line: number): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: REPOSITORY, commit: COMMIT },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/** One symbol of the fixture file, at its definition line. */
function symbol(qualifiedName: string, line = 1): Fact {
  return makeNodeFact({
    kind: 'symbol',
    value: { repository: REPOSITORY, file: repositoryPath(FILE), qualifiedName, symbolKind: 'method' },
    provenance: provenance(FILE, line),
    layer: 'extracted',
  });
}

/** One call edge of the fixture file. */
function call(from: Fact, to: Fact, line: number): Fact {
  return makeEdgeFact({ kind: 'call', value: { from: from.id, to: to.id, count: 1, precision: 'syntactic' }, provenance: provenance(FILE, line), layer: 'extracted' });
}

/**
 * The graph the reads answer from. The three callers of the target symbol are
 * `OrderService.Zed`, `OrderService.alpha` and `OrderService.beta`: in code
 * point order `Zed` comes first (0x5A before 0x61), and a locale-aware collation
 * (PostgreSQL's `en_US.UTF-8`) would put it last — so the order the reads answer
 * is the order this fixture can only produce one way.
 */
interface Fixture {
  readonly repository: Fact;
  readonly file: Fact;
  readonly module: Fact;
  readonly target: Fact;
  readonly isolated: Fact;
  readonly lonely: Fact;
  readonly callers: readonly Fact[];
  readonly calls: readonly Fact[];
  readonly defines: readonly Fact[];
  readonly contains: readonly Fact[];
  readonly claims: readonly Fact[];
  readonly coverage: Fact;
  readonly variable: Fact;
  readonly consumes: Fact;
  /** A symbol one call names whose own fact no unit holds: an end the graph does not answer. */
  readonly orphan: Fact;
  readonly orphanCall: Fact;
  /** A symbol the damaged claim rows are about: no other read of the fixture matches them. */
  readonly damagedSubject: Fact;
  readonly hub: Fact;
  readonly hubCalls: readonly Fact[];
  readonly wideCoverage: Fact;
}

function fixture(): Fixture {
  const repository = makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('README.md', 1), layer: 'extracted' });
  const file = makeNodeFact({
    kind: 'file',
    value: { repository: REPOSITORY, path: repositoryPath(FILE), roles: ['source'], language: 'typescript', bytes: 1_200, blob: 'b'.repeat(40) },
    provenance: provenance(FILE, 1),
    layer: 'extracted',
  });
  const module = makeNodeFact({ kind: 'module', value: { repository: REPOSITORY, name: 'checkout', seed: 'package', members: 4, importance: 0.5 }, provenance: provenance(FILE, 1), layer: 'extracted' });
  const target = symbol('OrderService.total', 40);
  const isolated = symbol('OrderService.unused', 60);
  const lonely = symbol('OrderService.lonely', 80);
  const zed = symbol('OrderService.Zed', 12);
  const alpha = symbol('OrderService.alpha', 20);
  const beta = symbol('OrderService.beta', 30);
  const callers = [zed, alpha, beta];
  const calls = [call(zed, target, 13), call(alpha, target, 21), call(beta, target, 31)];
  const defines = [target, isolated, zed, alpha, beta].map((held, index) => makeEdgeFact({
    kind: 'defines',
    value: { from: file.id, to: held.id },
    provenance: provenance(FILE, held.provenance.place?.range.startLine ?? index + 1),
    layer: 'extracted',
  }));
  const contains = [
    makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: file.id }, provenance: provenance('README.md', 1), layer: 'extracted' }),
    makeEdgeFact({ kind: 'contains', value: { from: module.id, to: file.id }, provenance: provenance(FILE, 1), layer: 'extracted' }),
  ];
  const claims = [
    makeNodeFact({
      kind: 'claim',
      value: { subject: { form: 'node', id: target.id }, predicate: 'is-implemented-by', object: { form: 'literal', text: 'the cart' }, text: 'the total comes from the cart', confidence: 0.8 },
      provenance: provenance(FILE, 40),
      layer: 'inferred',
    }),
    makeNodeFact({
      kind: 'claim',
      value: { subject: { form: 'node', id: alpha.id }, predicate: 'states', object: { form: 'node', id: target.id }, text: 'cancel states the total' },
      provenance: provenance(FILE, 20),
      layer: 'inferred',
    }),
  ];
  const coverageFact = makeNodeFact({
    kind: 'coverage',
    value: { repository: REPOSITORY, scope: module.id, complete: false, read: ['src/cart.ts', 'src/order.ts'], unread: [{ what: 'src/legacy.ts', reason: 'too-large' }] },
    provenance: provenance(FILE, 1),
    layer: 'extracted',
  });
  // The one edge of the fixture whose to end stands in another field of the edge's value: `consumes` names the
  // environment variable it uses in its `variable`, and the count of what a scope holds joins it there.
  const variable = makeNodeFact({ kind: 'environment-variable', value: { name: 'ORDER_API_BASE' }, provenance: provenance(FILE, 2), layer: 'extracted' });
  const consumes = makeEdgeFact({ kind: 'consumes', value: { from: file.id, variable: variable.id }, provenance: provenance(FILE, 2), layer: 'extracted' });
  // A call whose from end no unit holds: the edge stands and the node it names does not, which is the state
  // `neighbors` answers by id with `kind: null` (the checked writes refuse such a write; a retraction leaves it).
  const orphan = symbol('OrderService.orphan', 95);
  const orphanCall = makeEdgeFact({ kind: 'call', value: { from: symbol('OrderService.gone', 96).id, to: orphan.id, count: 1, precision: 'syntactic' }, provenance: provenance(FILE, 96), layer: 'extracted' });
  const damagedSubject = symbol('OrderService.damaged', 97);
  const hub = symbol('OrderService.hub', 100);
  const hubCalls = Array.from({ length: 20 }, (_unused, index) => call(symbol(`OrderService.caller${String(index).padStart(2, '0')}`, 101 + index), hub, 101 + index));
  const wideCoverage = makeNodeFact({
    kind: 'coverage',
    value: {
      repository: REPOSITORY,
      scope: 'the wide scope',
      complete: true,
      read: Array.from({ length: COVERAGE_READ_SAMPLE + 10 }, (_unused, index) => `src/file${String(index).padStart(3, '0')}.ts`),
      unread: Array.from({ length: COVERAGE_GAP_LIMIT + 3 }, (_unused, index) => ({ what: `src/gap${String(index).padStart(3, '0')}.ts`, reason: 'unsupported' })),
    },
    provenance: provenance(FILE, 1),
    layer: 'extracted',
  });
  return { repository, file, module, target, isolated, lonely, variable, consumes, orphan, orphanCall, damagedSubject, callers, calls, defines, contains, claims, coverage: coverageFact, hub, hubCalls, wideCoverage };
}

/** Everything the fixture publishes, in one unit: the graph the reads answer from. */
function fixtureFacts(graph: Fixture): readonly Fact[] {
  return [
    graph.repository, graph.file, graph.module, graph.target, graph.isolated, graph.lonely, graph.variable, graph.consumes,
    graph.orphan, graph.orphanCall, graph.damagedSubject, graph.hub,
    ...graph.callers, ...graph.calls, ...graph.hubCalls, ...graph.defines, ...graph.contains,
    ...graph.claims, graph.coverage, graph.wideCoverage,
  ];
}

/** One world: the process's owner with the fill's tables, the fixture graph published, and the reads' context. */
interface World {
  readonly owner: DatabaseOwner;
  readonly graph: Fixture;
  /** Publishes one unit's facts through the store's own sink, replacing what that unit held before. */
  publish(unitId: string, stageId: string, scope: string, digest: string, facts: readonly Fact[]): Promise<number>;
  /**
   * The context one reading unit reads through, with its reads recorded as that
   * unit's dependencies. The unit is created in this owner the first time it is
   * asked for (creating one is one insert, no second database), so a test that
   * reads from a shared owner still gets a generation of its own to read as.
   */
  reads(unitId: string, generation: number, limits?: Partial<typeof DEFAULT_GRAPH_READ_LIMITS>): Promise<GraphReadContext>;
  close(): Promise<void>;
}

/** Opens the owner, creates the fill's tables and publishes the fixture graph as the unit `graph/all`. */
async function openWorld(): Promise<World> {
  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const graph = fixture();
  await createUnit(owner, { unitId: 'graph/all', product: 'fixture-product', runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const publish = async (unitId: string, stageId: string, scope: string, digest: string, facts: readonly Fact[]): Promise<number> => {
    const record = await readUnit(owner, unitId);
    if (record === null) throw new Error(`the fixture publishes the unit "${unitId}", which the store does not hold`);
    const plan: UnitPlanRecord = { unitId, generation: record.generation, runId: record.runId, stageId, stageUnitId: scope, scope, stagePosition: 0, planPosition: 0, plannedAt: NOW };
    return await owner.transaction('write', async (executor) => await applyPublishedFacts({
      executor,
      unit: record,
      plan,
      digest,
      writes: facts.map((fact) => ({ kind: 'fact' as const, evidence: `${FILE}:1`, value: fact })),
    }));
  };
  await createUnit(owner, { unitId: 'reads/all', product: 'fixture-product', runId: 'run-reads', stageId: 'reads', scopeKey: 'all', inputsDigest: 'reads-inputs', retries: 0, at: NOW });
  await publish('graph/all', 'graph', 'all', 'graph-publication-1', fixtureFacts(graph));
  return {
    owner,
    graph,
    publish,
    reads: async (unitId, generation, limits) => {
      // The unit is made once per owner, the first time a test reads as it: `createUnit` inserts by id,
      // so a second call for the same unit is one row too many rather than the row that already stands.
      if (await readUnit(owner, unitId) === null) {
        await createUnit(owner, { unitId, product: 'fixture-product', runId: 'run-reads', stageId: 'reads', scopeKey: unitId, inputsDigest: `${unitId}-inputs`, retries: 0, at: NOW });
      }
      return await createGraphReadContext({
        database: owner,
        snapshot: await snapshotSource(),
        unit: { unitId, generation },
        clock: () => NOW,
        ...(limits === undefined ? {} : { limits }),
      });
    },
    close: async () => { await owner.close(); },
  };
}

/**
 * The one owner the read-only tests share: the pod this suite runs on holds 4 GB,
 * so the suite opens one PGlite for the fixture graph instead of one per test, and
 * a test that changes the graph (a publication, a damaged row) opens an owner of
 * its own (`world()`). A shared owner is not a shared reading unit: each test that
 * asserts what it recorded asks for a unit of its own.
 */
let shared: World | undefined;

/** The owner the read-only tests read from, opened once with the fixture graph in it. */
async function sharedWorld(): Promise<World> {
  if (shared === undefined) shared = await openWorld();
  return shared;
}

/** The pinned repositories the span reads answer from: the commit the test makes, nothing of this checkout. */
let pins: readonly RepositoryPin[] = [];

async function snapshotSource(): Promise<{ open(repository: string): Promise<import('../src/fill/snapshot.js').SnapshotReader> }> {
  const source = createGitSnapshotSource(() => Promise.resolve(pins));
  return { open: async (repository) => await source.open(repository) };
}

let scratch: string | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'madarch-graph-reads-'));
  const root = join(scratch, 'orders-api');
  await mkdir(join(root, 'src'), { recursive: true });
  const lines = Array.from({ length: 260 }, (_unused, index) => `export const line${String(index + 1)} = ${String(index + 1)};`);
  await writeFile(join(root, FILE), `${lines.join('\n')}\n`);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'one');
  pins = [{ id: 'orders-api', form: 'code', root, commit: git('rev-parse', 'HEAD').trim() }];
  shared = await openWorld();
  // Two claim rows the schema does not read, inserted past the store's own check (which refuses them): the
  // readers must refuse them by name rather than answer a claim nobody made. Each is about the fixture's
  // `damaged` symbol, so no other test's read of the fixture answers one.
  const damaged = shared.graph.damagedSubject.id;
  const rows: readonly [string, Record<string, unknown>][] = [
    [`claim:${'d'.repeat(64)}`, { subject: { form: 'node', id: damaged }, object: { form: 'literal', text: 'the cart' } }],
    [`claim:${'e'.repeat(64)}`, { object: { form: 'node', id: damaged }, predicate: 'is-implemented-by' }],
  ];
  await shared.owner.transaction('write', async (executor) => {
    for (const [id, value] of rows) {
      await executor.query(
        `INSERT INTO fill_fact (id, kind, schema_version, provenance, layer, status, value)
         VALUES ($1, 'claim', 1, $2::jsonb, 'inferred', 'proposed', $3::jsonb)`,
        [id, JSON.stringify(provenance(FILE, 40)), JSON.stringify(value)],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await shared?.close();
  shared = undefined;
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

/**
 * The canonical text of one read, built here from the read's own parts: the module
 * records a dependency under exactly this text (`readText`), and this test builds
 * it independently — its keys in code point order — so a text that dropped a key
 * or sorted nothing would fail here rather than pass by construction.
 */
function canonicalRead(parts: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort(byCodePoint)) sorted[key] = parts[key];
  return JSON.stringify(sorted);
}


/**
 * The edge kinds `neighbors` answers when the caller names none: every edge kind
 * of the schema but the two that place a node (`contains`, `defines`). 0026's own
 * case asks for the three callers of a symbol and no more, so the list is written
 * out here rather than read from the module.
 */
const NEIGHBOR_KINDS: readonly FactEdgeKind[] = [
  'binds', 'call', 'consumes', 'dependency', 'document-link', 'import', 'inherits',
  'interaction', 'provides', 'reference', 'resolves', 'task-key', 'transition',
];
/** The edge kinds that mean "this node names or uses that node": what `references` answers when it names none. */
const REFERENCE_KINDS: readonly FactEdgeKind[] = ['call', 'consumes', 'dependency', 'document-link', 'import', 'inherits', 'interaction', 'reference', 'resolves', 'transition'];

/** The digest a read is remembered by: the SHA-256 of the canonical JSON of its text, which is what the store records. */
function digestOf(text: string): string {
  return createHash('sha256').update(JSON.stringify({ query: text })).digest('hex');
}

/** The order the three callers of the fixture target are answered in: code point order, `Zed` before `alpha`. */
const CALLER_ORDER = [`${REPOSITORY}:${FILE}#OrderService.Zed`, `${REPOSITORY}:${FILE}#OrderService.alpha`, `${REPOSITORY}:${FILE}#OrderService.beta`];

describe('neighbors', () => {
  test('a symbol with three callers answers those three, sorted by code point, untruncated', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/neighbors', 1);
    const answer = await neighbors(reads, { tool: 'neighbors', id: opened.graph.target.id });
    expect(answer.rows.map((row) => row.neighbor.label)).toEqual(CALLER_ORDER);
    expect(answer.kinds).toEqual(NEIGHBOR_KINDS);
    expect(answer.rows.map((row) => row.direction)).toEqual(['in', 'in', 'in']);
    expect(answer.rows.map((row) => row.edge.kind)).toEqual(['call', 'call', 'call']);
    expect(answer.rows.map((row) => row.edge.count)).toEqual([1, 1, 1]);
    // A resolution edge says how it was resolved (madarch-tzte.21.6), so a reader
    // weighs a name-based call below one a compiler made.
    expect(answer.rows.map((row) => row.edge.precision)).toEqual(['syntactic', 'syntactic', 'syntactic']);
    expect(answer.rows.map((row) => row.edge.file)).toEqual([FILE, FILE, FILE]);
    expect(answer.rows.map((row) => row.edge.line)).toEqual([13, 21, 31]);
    expect(answer.truncated).toBe(false);
    expect(answer.marker).toBeNull();
    // 0026's cap is the whole answer, not only its rows.
    expect(answer.tokens).toBeLessThanOrEqual(DEFAULT_GRAPH_READ_LIMITS.answerTokens);

    // The two reads it made are the unit's own dependencies: the adjacent edges, then the nodes at their
    // other ends, each recorded with the membership of what it answered. The answer names each read by the
    // digest the orchestrator recorded it under.
    const query = canonicalRead({ read: 'adjacent', id: opened.graph.target.id, kinds: NEIGHBOR_KINDS });
    const nodes = canonicalRead({ read: 'facts', ids: [...answer.rows.map((row) => row.neighbor.id)].sort() });
    expect(answer.reads.map((read) => read.read)).toEqual(['adjacent', 'facts']);
    const recorded = await readUnitReads(opened.owner, 'reads/neighbors', 1);
    expect(recorded.map((read) => [read.query, read.members])).toEqual([[query, 3], [nodes, 3]]);
    expect(recorded[0]!.membership).not.toBe(recorded[1]!.membership);
    expect(answer.reads.map((read) => read.digest)).toEqual(recorded.map((read) => read.queryDigest));
  });

  test('the direction and the kinds it is asked for are what it answers', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const zed = opened.graph.callers[0]!;
    const outgoing = await neighbors(reads, { tool: 'neighbors', id: zed.id, direction: 'out' });
    expect(outgoing.rows.map((row) => [row.direction, row.edge.kind, row.neighbor.label])).toEqual([['out', 'call', `${REPOSITORY}:${FILE}#OrderService.total`]]);
    // A symbol's home is not its neighbourhood: the file's `defines` edge is answered when it is asked for.
    const incoming = await neighbors(reads, { tool: 'neighbors', id: zed.id, direction: 'in' });
    expect(incoming.rows).toEqual([]);
    const placement = await neighbors(reads, { tool: 'neighbors', id: zed.id, kinds: ['defines'] });
    expect(placement.rows.map((row) => [row.direction, row.edge.kind, row.neighbor.label])).toEqual([['in', 'defines', `${REPOSITORY}:${FILE}`]]);
    expect(placement.kinds).toEqual(['defines']);
    const calls = await neighbors(reads, { tool: 'neighbors', id: zed.id, kinds: ['call'] });
    expect(calls.rows.map((row) => [row.direction, row.neighbor.label])).toEqual([['out', `${REPOSITORY}:${FILE}#OrderService.total`]]);
  });

  test('a read that names no kind at all is refused by name', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    await expect(neighbors(reads, { tool: 'neighbors', id: opened.graph.target.id, kinds: [] })).rejects.toThrow(/names no edge kind/);
    await expect(neighbors(reads, { tool: 'neighbors', id: opened.graph.target.id, direction: 'sideways' as 'in' })).rejects.toThrow(/a direction is "in", "out" or "both"/);
  });

  test('a symbol nothing joins answers nothing, and that empty read is recorded as a dependency of its own', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/lonely', 1);
    const answer = await neighbors(reads, { tool: 'neighbors', id: opened.graph.lonely.id });
    expect(answer.rows).toEqual([]);
    expect(answer.truncated).toBe(false);
    expect(answer.marker).toBeNull();
    const recorded = await readUnitReads(opened.owner, 'reads/lonely', 1);
    expect(recorded.map((read) => [read.query, read.members])).toEqual([[canonicalRead({ read: 'adjacent', id: opened.graph.lonely.id, kinds: NEIGHBOR_KINDS }), 0]]);
    // An empty answer is a membership of its own, and it is not the membership of a read that answered rows.
    const answered = await neighbors(reads, { tool: 'neighbors', id: opened.graph.target.id });
    expect(answered.rows).toHaveLength(3);
    const after = await readUnitReads(opened.owner, 'reads/lonely', 1);
    expect(after[0]!.membership).not.toBe(after[1]!.membership);
  });

  test('the neighbours of a node the graph does not hold at all are still named by their id', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/orphan', 1);
    // The fixture's `orphan` is called by a symbol whose own fact no unit holds: the edge stands, and the
    // read answers the id it joins rather than dropping the row.
    const answer = await neighbors(reads, { tool: 'neighbors', id: opened.graph.orphan.id });
    expect(answer.rows.map((row) => [row.neighbor.kind, row.neighbor.label])).toEqual([[null, startsOf(opened.graph.orphanCall)]]);
  });
});

describe('references', () => {
  test('answers the places that cite the node, in code point order of the file and the line', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const answer = await references(reads, { tool: 'references', id: opened.graph.target.id });
    expect(answer.rows.map((row) => [row.from.label, row.edge.kind, row.edge.file, row.edge.line])).toEqual([
      [CALLER_ORDER[0], 'call', FILE, 13],
      [CALLER_ORDER[1], 'call', FILE, 21],
      [CALLER_ORDER[2], 'call', FILE, 31],
    ]);
    expect(answer.kinds).toEqual(REFERENCE_KINDS);
    expect(answer.truncated).toBe(false);
    // The file's own `defines` edge into the symbol is not a citation of it, so it is not a reference.
    expect(answer.rows.some((row) => row.edge.kind === 'defines')).toBe(false);
  });
});

describe('describe_scope', () => {
  test('answers the scope node, what it holds, how it stands and the coverage that names it', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const answer = await describeScope(reads, { tool: 'describe_scope', scope: opened.graph.module.id });
    expect(answer.node).toEqual({ id: opened.graph.module.id, kind: 'module', label: 'checkout', file: FILE, line: 1 });
    expect(answer.holds).toEqual([{ kind: 'file', count: 1 }]);
    expect(answer.edges).toEqual([{ kind: 'contains', direction: 'out', count: 1 }]);
    expect(answer.coverage.map((row) => [row.scope, row.complete, row.readCount, row.unread])).toEqual([
      [opened.graph.module.id, false, 2, [{ what: 'src/legacy.ts', reason: 'too-large' }]],
    ]);
    expect(answer.reads.map((read) => read.read)).toEqual(['fact', 'held', 'adjacent', 'facts-with']);
    expect(answer.reads.map((read) => read.digest)).toEqual([
      digestOf(canonicalRead({ read: 'fact', id: opened.graph.module.id })),
      digestOf(canonicalRead({ read: 'held', id: opened.graph.module.id, via: ['contains', 'defines'] })),
      digestOf(canonicalRead({ read: 'adjacent', id: opened.graph.module.id })),
      digestOf(canonicalRead({ read: 'facts-with', kind: 'coverage', field: 'scope', value: opened.graph.module.id })),
    ]);
  });

  test('the count joins every kind whose to end is a fact id, wherever the edge keeps it', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    // `consumes` names the environment variable it uses in its value's `variable`, not in a `to`.
    const held = await reads.read({ read: 'held', id: opened.graph.file.id, via: ['consumes'] });
    expect(held).toEqual([{ kind: 'environment-variable', count: 1 }]);
    // The kinds whose ends this read joins, and why the others are refused: each with what its end is.
    await expect(reads.read({ read: 'held', id: opened.graph.file.id, via: ['provides'] })).rejects
      .toThrow(/a "provides" edge's to end is the api-endpoint's contract id, which is the endpoint's own identity and not the fact id this read joins: the kinds whose to end this read joins by fact id are call, consumes, contains, defines, dependency, import, inherits, interaction, reference, resolves, transition/);
    await expect(reads.read({ read: 'held', id: opened.graph.file.id, via: ['task-key'] })).rejects
      .toThrow(/a "task-key" edge's to end is the tracker's key, not a node of the graph/);
    await expect(reads.read({ read: 'held', id: opened.graph.file.id, via: ['document-link'] })).rejects
      .toThrow(/a "document-link" edge's to end is a term, which may name a node of the graph or an address outside the repositories/);
  });

  test('a file holds the symbols it defines, and the repository holds its files', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const file = await describeScope(reads, { tool: 'describe_scope', scope: opened.graph.file.id });
    expect(file.holds).toEqual([{ kind: 'symbol', count: 5 }]);
    const repository = await describeScope(reads, { tool: 'describe_scope', scope: opened.graph.repository.id });
    expect(repository.holds).toEqual([{ kind: 'file', count: 1 }]);
    expect(repository.coverage).toEqual([]);
  });

  test('a scope the graph does not hold is refused by name, never answered empty', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    await expect(describeScope(reads, { tool: 'describe_scope', scope: 'module:notafact' })).rejects.toThrow(/describe_scope names the scope "module:notafact"/);
    await expect(describeScope(reads, { tool: 'describe_scope', scope: `module:${'0'.repeat(64)}` })).rejects.toThrow(/the graph holds no fact of that id/);
  });
});

describe('claims_about', () => {
  test('answers the claims about the node and the claims that name it, with the labels of the nodes they name', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const about = await claimsAbout(reads, { tool: 'claims_about', id: opened.graph.target.id, direction: 'about' });
    expect(about.rows).toHaveLength(1);
    expect(about.rows[0]).toMatchObject({ predicate: 'is-implemented-by', layer: 'inferred', status: 'proposed', text: 'the total comes from the cart', confidence: 0.8, file: FILE, line: 40 });
    expect(about.rows[0]!.subject).toEqual({ form: 'node', id: opened.graph.target.id, label: `${REPOSITORY}:${FILE}#OrderService.total` });
    expect(about.rows[0]!.object).toEqual({ form: 'literal', text: 'the cart' });

    const names = await claimsAbout(reads, { tool: 'claims_about', id: opened.graph.target.id, direction: 'names' });
    expect(names.rows.map((row) => row.predicate)).toEqual(['states']);
    expect(names.rows[0]!.object).toEqual({ form: 'node', id: opened.graph.target.id, label: `${REPOSITORY}:${FILE}#OrderService.total` });

    const both = await claimsAbout(reads, { tool: 'claims_about', id: opened.graph.target.id });
    expect(both.rows.map((row) => row.id).sort()).toEqual([...about.rows, ...names.rows].map((row) => row.id).sort());
    // The third read is the nodes the claims name, so every end that is a node carries the label a reader sees.
    expect(both.reads.map((read) => read.read)).toEqual(['facts-with', 'facts-with', 'facts']);
    expect(both.reads.map((read) => read.digest)).toEqual([
      digestOf(canonicalRead({ read: 'facts-with', kind: 'claim', field: 'subject.id', value: opened.graph.target.id })),
      digestOf(canonicalRead({ read: 'facts-with', kind: 'claim', field: 'object.id', value: opened.graph.target.id })),
      digestOf(canonicalRead({ read: 'facts', ids: [opened.graph.target.id, opened.graph.callers[1]!.id].sort() })),
    ]);
  });

  test('a claim row the schema does not read is refused by name, never answered with empty fields', async () => {
    const opened = await sharedWorld();
    // The two damaged rows are inserted with the fixture, in `beforeAll`: a row reaches the store only from
    // outside it (the store checks a write with `checkFact`), and a reader that answered it with empty fields
    // would answer a claim nobody made. They are about a node of their own, so no other read of the fixture
    // matches them.
    const damaged = `claim:${'d'.repeat(64)}`;
    const subjectless = `claim:${'e'.repeat(64)}`;
    const reads = await opened.reads('reads/damaged', 1);
    await expect(claimsAbout(reads, { tool: 'claims_about', id: opened.graph.damagedSubject.id, direction: 'about' })).rejects
      .toThrow(new RegExp(`${damaged} carries the predicate undefined: a claim says what it asserts about its subject, as one lower-case kebab token`));
    // And a claim whose subject is not a term at all: the same policy, at the field that names it. That row is
    // read through the object it names, since a claim without a subject cannot be found by the subject it has not.
    await expect(claimsAbout(reads, { tool: 'claims_about', id: opened.graph.damagedSubject.id, direction: 'names' })).rejects
      .toThrow(new RegExp(`${subjectless} carries undefined at value.subject: a claim's subject is a node, an address outside the repositories, or a literal`));
  });

  test('a node no claim names answers nothing', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const answer = await claimsAbout(reads, { tool: 'claims_about', id: opened.graph.isolated.id });
    expect(answer.rows).toEqual([]);
    expect(answer.truncated).toBe(false);
  });
});

describe('coverage', () => {
  test('answers what was read and every gap, and answers null for a scope no stage covered', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const answer = await coverage(reads, { tool: 'coverage', scope: opened.graph.module.id });
    expect(answer.complete).toBe(false);
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0]).toMatchObject({ scope: opened.graph.module.id, complete: false, readCount: 2, readCut: 0, unreadCut: 0, file: FILE, line: 1 });
    expect(answer.rows[0]!.read).toEqual(['src/cart.ts', 'src/order.ts']);
    expect(answer.rows[0]!.unread).toEqual([{ what: 'src/legacy.ts', reason: 'too-large' }]);

    const none = await coverage(reads, { tool: 'coverage', scope: 'a scope nobody covered' });
    expect(none.rows).toEqual([]);
    expect(none.complete).toBeNull();
    expect(none.truncated).toBe(false);
  });

  test('the sample of what was read and the gaps each name what they left out', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const answer = await coverage(reads, { tool: 'coverage', scope: 'the wide scope' });
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0]!.readCount).toBe(COVERAGE_READ_SAMPLE + 10);
    expect(answer.rows[0]!.read).toHaveLength(COVERAGE_READ_SAMPLE);
    expect(answer.rows[0]!.readCut).toBe(10);
    expect(answer.rows[0]!.unread).toHaveLength(COVERAGE_GAP_LIMIT);
    expect(answer.rows[0]!.unreadCut).toBe(3);
    expect(answer.truncated).toBe(true);
    expect(answer.marker).toContain(`10 entries of what ${opened.graph.wideCoverage.id} read were cut by the ${COVERAGE_READ_SAMPLE}-entry sample`);
    expect(answer.marker).toContain(`3 gaps of ${opened.graph.wideCoverage.id} were cut by the ${COVERAGE_GAP_LIMIT}-gap cap`);
  });
});

describe('the caps 0026 fixes', () => {
  test('the defaults are 8K tokens and 200 lines, and a unit reads under the caps it is given', async () => {
    expect(DEFAULT_GRAPH_READ_LIMITS).toEqual({ answerTokens: 8_000, spanLines: 200, charactersPerToken: 4 });
    const opened = await sharedWorld();
    expect((await opened.reads('reads/all', 1)).limits).toEqual(DEFAULT_GRAPH_READ_LIMITS);
    expect((await opened.reads('reads/all', 1, { spanLines: 10 })).limits).toEqual({ ...DEFAULT_GRAPH_READ_LIMITS, spanLines: 10 });
  });

  test('an answer the cap cuts says so, and names how many rows were cut', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1, { answerTokens: 400 });
    const answer = await neighbors(reads, { tool: 'neighbors', id: opened.graph.hub.id });
    expect(answer.rows.length).toBeGreaterThan(0);
    expect(answer.rows.length).toBeLessThan(20);
    expect(answer.truncated).toBe(true);
    expect(answer.marker).toBe(`truncated: the neighbours of ${opened.graph.hub.id} holds 20 rows and the answer's 400-token cap holds ${answer.rows.length}: ${20 - answer.rows.length} rows were cut`);
    // The cap holds the whole answer, the request and the marker included, not only the rows it cut.
    expect(answer.tokens).toBeLessThanOrEqual(400);
    // What it did hold is the first of the rows in code point order, so a cut answer is a prefix and never a
    // different sample.
    const whole = await neighbors(await opened.reads('reads/all', 1), { tool: 'neighbors', id: opened.graph.hub.id });
    expect(answer.rows.map((row) => row.neighbor.id)).toEqual(whole.rows.slice(0, answer.rows.length).map((row) => row.neighbor.id));
  });

  test('a row too large for the cap leaves the answer with none of them and a marker that says so', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1, { answerTokens: 1 });
    const answer = await neighbors(reads, { tool: 'neighbors', id: opened.graph.hub.id });
    expect(answer.rows).toEqual([]);
    expect(answer.truncated).toBe(true);
    expect(answer.marker).toBe(`truncated: the neighbours of ${opened.graph.hub.id} holds 20 rows and the answer's 1-token cap holds 0: 20 rows were cut`);
    // A cap below the answer's own envelope (its request and its reads) cannot be met: the smallest answer this
    // module writes is that envelope, and the marker says the cap held none of the rows.
    expect(answer.tokens).toBeGreaterThan(1);
  });
});

describe('evidence_span', () => {
  test('answers the lines of the pinned commit, counted as a reader counts them', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const answer = await evidenceSpan(reads, { tool: 'evidence_span', repository: 'orders-api', commit: pins[0]!.commit, file: FILE, startLine: 3, endLine: 5 });
    expect(answer.lines).toEqual([
      { line: 3, text: 'export const line3 = 3;' },
      { line: 4, text: 'export const line4 = 4;' },
      { line: 5, text: 'export const line5 = 5;' },
    ]);
    expect([answer.startLine, answer.endLine, answer.totalLines, answer.asked]).toEqual([3, 5, 260, { startLine: 3, endLine: 5 }]);
    expect(answer.truncated).toBe(false);
    expect(answer.marker).toBeNull();
    expect(answer.reads).toEqual([{ read: 'span', digest: digestOf(canonicalRead({ read: 'span', repository: 'orders-api', commit: pins[0]!.commit, file: FILE, startLine: 3, endLine: 5 })) }]);
  });

  test('a span longer than the cap is answered with the lines that fit and a marker naming the cut', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const answer = await evidenceSpan(reads, { tool: 'evidence_span', repository: 'orders-api', commit: pins[0]!.commit, file: FILE });
    expect(answer.lines).toHaveLength(200);
    expect([answer.startLine, answer.endLine, answer.totalLines]).toEqual([1, 200, 260]);
    expect(answer.cut).toBe(60);
    expect(answer.truncated).toBe(true);
    expect(answer.marker).toBe(`truncated: asked lines 1\u2013260 of ${FILE} (260 lines); this answer holds lines 1\u2013200 (200 lines): 60 lines were cut (60 past the 200-line cap of an evidence span)`);
  });

  test('an end past the file\u2019s last line is the file\u2019s own lines, and a start past it is refused by name', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const tail = await evidenceSpan(reads, { tool: 'evidence_span', repository: 'orders-api', commit: pins[0]!.commit, file: FILE, startLine: 259, endLine: 900 });
    expect(tail.lines.map((line) => line.line)).toEqual([259, 260]);
    // What was asked, as it was asked (900), and what the answer holds (the file's own last line).
    expect([tail.asked.endLine, tail.endLine, tail.cut, tail.truncated]).toEqual([900, 260, 0, false]);
    await expect(evidenceSpan(reads, { tool: 'evidence_span', repository: 'orders-api', commit: pins[0]!.commit, file: FILE, startLine: 900 }))
      .rejects.toThrow(new RegExp(`asks for line 900 of ${FILE.replace('/', '\\/')} at ${pins[0]!.commit} in the repository "orders-api", and that file has 260 lines`));
    await expect(evidenceSpan(reads, { tool: 'evidence_span', repository: 'orders-api', commit: 'f'.repeat(40), file: FILE }))
      .rejects.toThrow(/is pinned at/);
  });

  test('the lines of a text are counted as a reader counts them', () => {
    expect(linesOf('')).toEqual([]);
    expect(linesOf('a\nb\n')).toEqual(['a', 'b']);
    expect(linesOf('a\nb')).toEqual(['a', 'b']);
  });
});

describe('the text one read is recorded by', () => {
  test('is the canonical JSON of the read, its keys and its sets in order', () => {
    // The exact texts, written here: a text that sorted nothing or dropped a key would fail these.
    expect(readText({ read: 'fact', id: `module:${'a'.repeat(64)}` })).toBe(`{"id":"module:${'a'.repeat(64)}","read":"fact"}`);
    expect(readText({ read: 'facts', ids: ['b', 'a', 'a'] })).toBe('{"ids":["a","b"],"read":"facts"}');
    expect(readText({ read: 'held', id: 'module:x', via: ['defines', 'contains'] })).toBe('{"id":"module:x","read":"held","via":["contains","defines"]}');
    expect(readText({ read: 'span', repository: 'orders-api', commit: 'c'.repeat(40), file: FILE, startLine: 1, endLine: 2 }))
      .toBe(`{"commit":"${'c'.repeat(40)}","endLine":2,"file":"${FILE}","read":"span","repository":"orders-api","startLine":1}`);
    // Two requests that differ only in how a set was written are one read: one dependency, rechecked once.
    expect(readText({ read: 'facts', ids: ['b', 'a'] })).toBe(readText({ read: 'facts', ids: ['a', 'b', 'a'] }));
    expect(readText({ read: 'adjacent', id: 'module:x', kinds: ['reference', 'call'] })).toBe(readText({ read: 'adjacent', id: 'module:x', kinds: ['call', 'reference'] }));
  });

  test('is a read again when it is parsed back, and a text that is no read is refused by name', () => {
    const symbol = `symbol:${'a'.repeat(64)}`;
    const request: GraphRead = { read: 'adjacent', id: symbol, kinds: ['reference', 'call'] };
    expect(parseGraphRead(readText(request))).toEqual({ read: 'adjacent', id: symbol, kinds: ['call', 'reference'] });
    // A stage's own SQL is not this module's read, and is left for the store to answer.
    expect(parseGraphRead('SELECT kind FROM fill_fact')).toBeNull();
    expect(() => parseGraphRead('{"read":"nope"}')).toThrow(/names "nope": a read of the graph is one of fact, facts, adjacent, held, facts-with, span/);
    expect(() => parseGraphRead('{"read":"fact"}')).toThrow(/names undefined: a fact id is the kind, a colon/);
    expect(() => parseGraphRead('{"read":')).toThrow(/opens a JSON object and does not parse as one/);
  });
});

describe('the reader over the store', () => {
  test('answers the fill’s own reads, an empty list of kinds by name, and a stage’s own SQL as it stands', async () => {
    const opened = await sharedWorld();
    const reader = createFactGraphReader({ database: opened.owner, snapshot: await snapshotSource() });
    const rows = await reader.query(`SELECT id, kind FROM fill_fact WHERE kind = 'call'`);
    const calls = [...opened.graph.calls, ...opened.graph.hubCalls, opened.graph.orphanCall];
    expect(rows).toHaveLength(calls.length);
    expect(rows.every((row) => (row as { kind: string }).kind === 'call')).toBe(true);
    // A read asking for no kind at all is refused by name rather than sent to the database as SQL that cannot run.
    await expect(reader.query(JSON.stringify({ read: 'adjacent', id: opened.graph.target.id, kinds: [] }))).rejects.toThrow(/names no edge kind/);
    await expect(reader.query(JSON.stringify({ read: 'held', id: opened.graph.module.id, via: ['document-link'] }))).rejects.toThrow(/a "document-link" edge's to end is a term, which may name a node of the graph or an address outside the repositories/);
    await expect(reader.query('SELECT no_such_column FROM fill_fact')).rejects.toThrow(/no_such_column/);
  });

  test('a describe_scope of a fact that is no scope is refused by name', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    await expect(describeScope(reads, { tool: 'describe_scope', scope: opened.graph.target.id })).rejects.toThrow(/which is "symbol" fact: a scope is one of directory, file, module, package, repository, and what another kind of fact holds would read as a scope that holds nothing/);
  });
});

describe('one entrance for every tool', () => {
  test('a call is dispatched by the tool it names', async () => {
    const opened = await sharedWorld();
    const reads = await opened.reads('reads/all', 1);
    const dispatched = await callGraphRead(reads, { tool: 'neighbors', id: opened.graph.target.id });
    const direct = await neighbors(reads, { tool: 'neighbors', id: opened.graph.target.id });
    expect(dispatched).toEqual(direct);
    await expect(callGraphRead(reads, { tool: 'nope' } as unknown as Parameters<typeof callGraphRead>[1])).rejects.toThrow(/is no tool of the fill/);
  });
});

// ---------------------------------------------------------------------------------------------
// The reads a unit makes are its dependencies, and a moved graph replaces it
// ---------------------------------------------------------------------------------------------

/** One world with a real orchestrator over the fill's own tables: the run's units read the fixture graph. */
interface RunWorld {
  readonly owner: DatabaseOwner;
  readonly orchestrator: FillOrchestrator;
  readonly graph: Fixture;
  /** Publishes one unit's facts, replacing what that unit held: a later publication that changes the graph. */
  publish(unitId: string, facts: readonly Fact[]): Promise<number>;
  /** Closes the queue and the owner. */
  close(): Promise<void>;
}

const QUEUE = 'fill-units';

/** The fact the reading stage drafts once its tools answered: a stage publishes what it read. */
const READER_FACT = makeNodeFact({ kind: 'module', value: { repository: REPOSITORY, name: 'reader-summary', seed: 'cluster' }, provenance: provenance(FILE, 1), layer: 'inferred' });

/**
 * Opens a world whose stage reads through the graph reads: the process's owner,
 * the fill's own fact store as the sink, and the graph seam of the orchestrator
 * wired to this module's reader, so a read the stage makes is recorded by the
 * orchestrator and replayed at publication.
 */
async function openRunWorld(): Promise<RunWorld> {
  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const queue = await createPgBossQueue({ owner, supervise: false });
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, retryDelayMs: 0 };
  await queue.declare({
    name: QUEUE,
    leaseSeconds: Math.max(1, Math.ceil(limits.leaseMs / 1000)),
    retries: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
    singletons: true,
  });
  const graph = fixture();
  const source = await snapshotSource();
  const stage: FillStage = {
    id: 'reads',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'reader-facts', schemaVersion: 1, scope: 'repository' }],
    configSchema: Type.Object({}),
    defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [{ id: 'all', scope: 'all' }], coverage: 'planned' }),
    execute: async (unit, context) => {
      const reads = graphReadsOver(context.graph);
      const three = await neighbors(reads, { tool: 'neighbors', id: graph.target.id });
      if (three.rows.length !== 3) throw new Error(`the stage read ${three.rows.length} callers of the target, and the fixture holds three`);
      await coverage(reads, { tool: 'coverage', scope: 'a scope nobody covered' });
      context.draft.write({ kind: 'fact', evidence: `${FILE}:1`, value: READER_FACT });
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
  const orchestrator = createOrchestrator({
    database: owner,
    registry: new StageRegistry().register(stage),
    queue,
    queueName: QUEUE,
    product: 'fixture-product',
    configuration: () => undefined,
    snapshot: () => SNAPSHOT,
    graph: (_ref, transaction) => createFactGraphReader({
      database: owner,
      snapshot: source,
      ...(transaction === undefined ? {} : { executor: transaction }),
    }),
    inputs: () => ({ commit: COMMIT }),
    facts: FACT_APPLICATION,
    clock: () => NOW,
    limits: { retryDelayMs: 0 },
  });
  const seeds = new Map<string, string>();
  await createUnit(owner, { unitId: 'graph/all', product: 'fixture-product', runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const publish = async (unitId: string, facts: readonly Fact[]): Promise<number> => {
    const record = await readUnit(owner, unitId);
    if (record === null) throw new Error(`the fixture publishes the unit "${unitId}", which the store does not hold`);
    const digest = `publication-${seeds.size + 1}`;
    seeds.set(unitId, digest);
    const plan: UnitPlanRecord = { unitId, generation: record.generation, runId: record.runId, stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW };
    return await owner.transaction('write', async (executor) => await applyPublishedFacts({
      executor,
      unit: record,
      plan,
      digest,
      writes: facts.map((fact) => ({ kind: 'fact' as const, evidence: `${FILE}:1`, value: fact })),
    }));
  };
  await publish('graph/all', fixtureFacts(graph));
  return {
    owner,
    orchestrator,
    graph,
    publish,
    close: async () => { await queue.stop(); await owner.close(); },
  };
}

describe('every read is the reading unit\u2019s dependency', () => {
  test('the reads are recorded with their memberships, an empty answer included, and a later publication that changes one marks the unit stale', async () => {
    const opened = await openRunWorld();
    try {
      const runId = 'run-reads';
      expect((await startRun(opened.orchestrator, { runId })).ok).toBe(true);
      const plan = await planRun(opened.orchestrator, { runId });
      expect(plan.outcome).toBe('planned');
      await admitUnits(opened.orchestrator, { runId });
      const worked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
      expect(worked.result).toBe('published');
      expect((await readUnit(opened.owner, 'reads/all'))?.state).toBe('published');

      // Every read the stage made is its own dependency: the query and the membership of what it answered.
      const target = opened.graph.target.id;
      const adjacent = readText({ read: 'adjacent', id: target, kinds: NEIGHBOR_EDGE_KINDS });
      const nodes = readText({ read: 'facts', ids: [...opened.graph.callers.map((caller) => caller.id)].sort() });
      const none = readText({ read: 'facts-with', kind: 'coverage', field: 'scope', value: 'a scope nobody covered' });
      const recorded = await readUnitReads(opened.owner, 'reads/all', 1);
      expect(recorded.map((read) => [read.query, read.members])).toEqual([[adjacent, 3], [nodes, 3], [none, 0]]);
      expect(new Set(recorded.map((read) => read.membership)).size).toBe(3);

      // A later publication changes what one recorded read answers: one more caller of the target.
      const late = symbol('OrderService.late', 70);
      await opened.publish('graph/all', [...fixtureFacts(opened.graph), late, call(late, opened.graph.target, 71)]);

      const sweep = await invalidateStaleUnits(opened.orchestrator, { runId });
      expect(sweep.refused).toEqual([]);
      expect(sweep.invalidated).toEqual([
        { unitId: 'reads/all', generation: 1, replacement: 2, cause: 'a read the generation recorded answers something else now' },
      ]);
      const generations = await readUnitGenerations(opened.owner, 'reads/all');
      expect(generations.map((generation) => `${generation.generation}:${generation.state}`)).toEqual(['1:stale', '2:planned']);
    } finally {
      await opened.close();
    }
  }, 120_000);
});
