/**
 * The per-unit MCP server (madarch-tzte.22.2; decisions 0026, "Agents and tools"
 * and "Writing", and 0027): one server per agent unit, bound to that unit's
 * snapshot, scope and limits, passed into the ACP session; its ten tools answer
 * what madarch-tzte.20.3's reads and madarch-tzte.20.4's writes answer, through
 * the background server that owns the database; every call is recorded as the
 * unit's dependency; an answer past the unit's cap carries the marker that says
 * what was cut; and the drafts other units of the run hold are shown as drafts,
 * marked, never mixed with the published facts.
 *
 * Every expectation here is taken from the task and from the decisions, never
 * from the modules: 0026's 8K-token answer cap and ~200-line span, the ten tool
 * names of 0026's two paragraphs, the code point orders, the refusal that names a
 * place outside a unit's scope, and the marker's own words. The graph is one the
 * test publishes through the store's own sink, the commit is one the test makes
 * with git, and nothing here reads this checkout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { byCodePoint } from '../src/model/order.js';
import { FACT_APPLICATION, applyPublishedFacts, createFactStoreSchema } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import {
  createFactGraphReader,
  DEFAULT_GRAPH_READ_LIMITS,
  type GraphReadLimits,
} from '../src/fill/graph-reads.js';
import { connectAcpAgent, type AcpConnection, type AcpMcpServer } from '../src/fill/acp.js';
import { recordedDraftSet } from '../src/fill/checked-writes.js';
import { createFillOrchestratorService, type FillOrchestratorService, type ProductFillWiring } from '../src/fill/orchestrator-host.js';
import {
  createOrchestratorSchema,
  readUnitDraft,
  readUnitReads,
  recordUnitDraft,
  recordUnitPlan,
  type RunSnapshot,
} from '../src/fill/orchestrator-store.js';
import { StageRegistry } from '../src/fill/registry.js';
import { createGitSnapshotSource, type RepositoryPin, type SnapshotSource } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readUnit } from '../src/fill/state-store.js';
import {
  callUnitTool,
  createUnitToolsHost,
  UNIT_TOOL_NAMES,
  UNIT_TOOL_PATH,
  UNIT_TOOL_TOKEN_VARIABLE,
  UNIT_TOOL_URL_VARIABLE,
  UNIT_TOOLS,
  type UnitToolAnswer,
  type UnitToolsHandle,
} from '../src/fill/unit-tools.js';
import {
  answerUnitMcpMessage,
  MCP_FALLBACK_VERSION,
  MCP_PROTOCOL_VERSIONS,
  serveUnitMcp,
  UNIT_MCP_INFO,
} from '../src/fill/unit-mcp.js';
import { unitToolEnvironment, unitToolProxy } from '../src/fill/unit-mcp-server.js';
import { startServer, type StartedServer } from '../src/server/http.js';

const NOW = 1_700_000_000_000;
const REPOSITORY = 'acme-shop';
const FILE = 'src/order.ts';
const OTHER_FILE = 'README.md';
const RUN = 'run-2026-10-18T21:00Z';
const OTHER_RUN = 'run-2026-10-17T09:00Z';
/** The unit whose tools the suite drives. */
const UNIT = { unitId: 'agent/unit-a', generation: 1 };
const SNAPSHOT: RunSnapshot = { repository: 'example.com/acme/shop', defaultBranch: 'main', commit: 'b'.repeat(40), registryHash: 'sha256:registry' };
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

// ---------------------------------------------------------------------------------------------
// The world: a published graph, a pinned commit, a unit's plan and another unit's draft
// ---------------------------------------------------------------------------------------------

/** One provenance: a fact read out of a file of the fixture repository at the pinned commit. */
function provenance(file: string, line: number): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: REPOSITORY, commit: COMMIT },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 12 } },
  };
}

/** One symbol of the fixture file, at its definition line. */
function symbol(qualifiedName: string, line: number): Fact {
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

/** One claim about one node, as an agent unit drafts it. */
function claimAbout(subject: Fact, text: string, line: number): Fact {
  return makeNodeFact({
    kind: 'claim',
    value: { subject: { form: 'node', id: subject.id }, predicate: 'is-checkout-total', object: { form: 'literal', text }, text },
    provenance: provenance(FILE, line),
    layer: 'inferred',
  });
}

/** The graph the tools answer from, and the ids the expectations name. */
interface Graph {
  readonly repository: Fact;
  readonly file: Fact;
  readonly target: Fact;
  readonly callers: readonly Fact[];
}

function graphFacts(graph: Graph): readonly Fact[] {
  const defines = [graph.target, ...graph.callers].map((held) => makeEdgeFact({
    kind: 'defines',
    value: { from: graph.file.id, to: held.id },
    provenance: provenance(FILE, held.provenance.place?.range.startLine ?? 1),
    layer: 'extracted',
  }));
  return [graph.repository, graph.file, ...graph.callers, graph.target, ...defines, ...graph.callers.map((caller, index) => call(caller, graph.target, 13 + index * 10))];
}

interface World {
  readonly owner: DatabaseOwner;
  readonly graph: Graph;
  readonly commit: string;
  readonly pins: readonly RepositoryPin[];
  readonly snapshot: SnapshotSource;
  readonly service: FillOrchestratorService;
  readonly server: StartedServer;
  /** The unit's tools, opened for {@link UNIT} on the running server. */
  tools(unit?: { readonly unitId: string; readonly generation: number }, limits?: Partial<GraphReadLimits>): Promise<UnitToolsHandle>;
  /** One tool call of an open session, answered by the host those tools belong to: the service's own registry. */
  call(handle: UnitToolsHandle, tool: string, argumentsValue: unknown): Promise<UnitToolAnswer>;
  close(): Promise<void>;
}

let root: string | undefined;
let COMMIT = SNAPSHOT.commit;
let world: World | undefined;

/** Publishes one unit's facts through the store's own sink, which is where a stage's publication lands. */
async function publish(owner: DatabaseOwner, unitId: string, stageId: string, scope: string, facts: readonly Fact[]): Promise<void> {
  const record = await readUnit(owner, unitId);
  if (record === null) throw new Error(`the fixture publishes the unit "${unitId}", which the store does not hold`);
  await owner.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: record,
    plan: { unitId, generation: record.generation, runId: record.runId, stageId, stageUnitId: scope, scope, stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: `${unitId}-publication-1`,
    writes: facts.map((fact) => ({ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMIT}:${FILE}`, value: fact })),
  }));
}

async function openWorld(): Promise<World> {
  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const queue = await createPgBossQueue({ owner, supervise: false });
  const graph: Graph = {
    repository: makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance(OTHER_FILE, 1), layer: 'extracted' }),
    file: makeNodeFact({ kind: 'file', value: { repository: REPOSITORY, path: repositoryPath(FILE), roles: ['source'], language: 'typescript', bytes: 400, blob: 'c'.repeat(40) }, provenance: provenance(FILE, 1), layer: 'extracted' }),
    target: symbol('OrderService.total', 40),
    callers: [symbol('OrderService.Zed', 12), symbol('OrderService.alpha', 20), symbol('OrderService.beta', 30)],
  };
  await createUnit(owner, { unitId: 'graph/all', product: 'fixture-product', runId: 'run-fixture', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  await publish(owner, 'graph/all', 'graph', 'all', graphFacts(graph));
  // The unit's own plan: the row that names the run its drafts belong to and the scope it covers (0027).
  await recordUnitPlan(owner, { unitId: UNIT.unitId, generation: UNIT.generation, runId: RUN, stageId: 'agent', stageUnitId: 'unit-a', scope: `${REPOSITORY}:src`, stagePosition: 0, planPosition: 0, at: NOW });
  // Another unit of the same run, planned for the same folder, holding a claim about the target symbol
  // as draft; and one of another run, which is not this unit's business at all.
  await recordUnitPlan(owner, { unitId: 'agent/unit-b', generation: 1, runId: RUN, stageId: 'agent', stageUnitId: 'unit-b', scope: `${REPOSITORY}:src`, stagePosition: 0, planPosition: 1, at: NOW });
  await recordUnitDraft(owner, { unitId: 'agent/unit-b', generation: 1, at: NOW, writes: [{ kind: 'fact', evidence: `${REPOSITORY}@${COMMIT}:${FILE}`, value: claimAbout(graph.target, 'The order total is the checkout total', 40) }] });
  await recordUnitPlan(owner, { unitId: 'agent/unit-c', generation: 1, runId: OTHER_RUN, stageId: 'agent', stageUnitId: 'unit-c', scope: `${REPOSITORY}:src`, stagePosition: 0, planPosition: 2, at: NOW });
  await recordUnitDraft(owner, { unitId: 'agent/unit-c', generation: 1, at: NOW, writes: [{ kind: 'fact', evidence: `${REPOSITORY}@${COMMIT}:${FILE}`, value: claimAbout(graph.target, 'A draft of another run', 40) }] });

  const pins: readonly RepositoryPin[] = [{ id: REPOSITORY, form: 'code', root: join(root!, 'orders-api'), commit: COMMIT }];
  const snapshot = createGitSnapshotSource(() => pins);
  const wiring: ProductFillWiring = {
    snapshot: () => SNAPSHOT,
    configuration: () => undefined,
    graph: () => createFactGraphReader({ database: owner, snapshot }),
    inputs: () => ({}),
    source: () => snapshot,
  };
  const service = createFillOrchestratorService({
    home: join(root!, 'products'),
    registry: new StageRegistry(),
    owner,
    queueFactory: async () => queue,
    wiring: () => wiring,
  });
  const appFolder = join(root!, 'app');
  mkdirSync(appFolder, { recursive: true });
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>fixture app</title>');
  const home = join(root!, 'products-home');
  mkdirSync(home, { recursive: true });
  // Port 0: the server names a free one, and nothing here takes another process's port.
  const server = await startServer({ productHome: home, appFolder, port: 0, orchestrator: service, log: () => undefined, errorLog: () => undefined });
  const opened: World = {
    owner,
    graph,
    commit: COMMIT,
    pins,
    snapshot,
    service,
    server,
    tools: async (unit = UNIT, limits) => await service.unitTools({
      product: { name: 'fixture-product', folder: home },
      unit,
      url: `${server.url}${UNIT_TOOL_PATH}`,
      draft: recordedDraftSet(owner, { ...unit, at: () => NOW }),
      ...(limits === undefined ? {} : { limits }),
    }),
    call: async (handle, tool, argumentsValue) => {
      const answered = await service.unitTool({ token: tokenOf(handle), tool, arguments: argumentsValue });
      if (answered === null) throw new Error(`the session of ${tool} is not open in the service's own registry`);
      return answered;
    },
    close: async () => {
      await server.stop();
      await service.stop();
      await queue.stop().catch(() => undefined);
      await owner.close();
    },
  };
  return opened;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-unit-tools-'));
  const checkout = join(root, 'orders-api');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  const lines = Array.from({ length: 40 }, (_unused, index) => `export const line${String(index + 1)} = ${String(index + 1)};`);
  writeFileSync(join(checkout, FILE), `${lines.join('\n')}\n`);
  writeFileSync(join(checkout, OTHER_FILE), '# acme shop\n');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'one');
  COMMIT = git('rev-parse', 'HEAD').trim();
  world = await openWorld();
}, 120_000);

afterAll(async () => {
  await world?.close();
  world = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The world one test drives; opened once for the suite, since every test reads it. */
function opened(): World {
  if (world === undefined) throw new Error('the suite\'s world was not opened');
  return world;
}

/** The token a handle\'s server carries, as the agent passes it back. */
function tokenOf(handle: UnitToolsHandle): string {
  const server = handle.mcpServer as Extract<AcpMcpServer, { command: string }>;
  return String(server.env?.[UNIT_TOOL_TOKEN_VARIABLE]);
}

// ---------------------------------------------------------------------------------------------
// The protocol: what a unit's server answers, and what it refuses
// ---------------------------------------------------------------------------------------------

describe('the Model Context Protocol a unit\'s server speaks', () => {
  test('initialize answers the protocol version, the one capability and this server\'s own name', async () => {
    const answered = await answerUnitMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'an-agent', version: '1' } } }, { call: async () => ({ answer: {}, isError: false }) });
    expect(answered).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: UNIT_MCP_INFO },
    });
    // A version this build does not know is answered with the newest it does, which is the specification's rule.
    const unknown = await answerUnitMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { call: async () => ({ answer: {}, isError: false }) });
    expect((unknown as { result: { protocolVersion: string } }).result.protocolVersion).toBe(MCP_FALLBACK_VERSION);
  });

  test('tools/list answers the ten tools of 0026, in the catalogue\'s own order, each with its arguments\' schema', async () => {
    const answered = await answerUnitMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { call: async () => ({ answer: {}, isError: false }) });
    const tools = (answered as { result: { tools: { name: string; description: string; inputSchema: { type?: string } }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([...UNIT_TOOL_NAMES]);
    expect([...UNIT_TOOL_NAMES]).toEqual([
      'describe_scope', 'neighbors', 'references', 'claims_about', 'coverage', 'evidence_span',
      'assert_fact', 'propose_entity', 'link', 'raise_question',
    ]);
    expect(tools.every((tool) => tool.description.length > 0 && tool.inputSchema.type === 'object')).toBe(true);
  });

  test('a notification earns no answer, and neither does a response to a request this server never sent', async () => {
    expect(await answerUnitMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { call: async () => ({ answer: {}, isError: false }) })).toBeNull();
    expect(await answerUnitMcpMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }, { call: async () => ({ answer: {}, isError: false }) })).toBeNull();
    expect(await answerUnitMcpMessage({ jsonrpc: '2.0', id: 4, result: {} }, { call: async () => ({ answer: {}, isError: false }) })).toBeNull();
  });

  test('a method this server has none of is refused by name, naming what it does offer', async () => {
    const answered = await answerUnitMcpMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, { call: async () => ({ answer: {}, isError: false }) });
    expect(answered).toMatchObject({ jsonrpc: '2.0', id: 5, error: { code: -32601 } });
    expect(String((answered as { error: { message: string } }).error.message)).toContain('it offers initialize, ping, tools/list and tools/call');
  });

  test('a call of a tool this server has not is a protocol error naming the tools it has, before anything is asked of the host', async () => {
    let asked = 0;
    const answered = await answerUnitMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } }, { call: async () => { asked += 1; return { answer: {}, isError: false }; } });
    expect(answered).toMatchObject({ id: 6, error: { code: -32602 } });
    expect(String((answered as { error: { message: string } }).error.message)).toContain('the tools are describe_scope, neighbors');
    expect(asked).toBe(0);
  });

  test('a tool\'s own refusal is a result the agent reads, with isError, and never a protocol error', async () => {
    const answered = await answerUnitMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'neighbors', arguments: { id: 'symbol:' + 'a'.repeat(64) } } }, {
      call: async () => ({ answer: { ok: false, refusals: [{ field: 'id', reason: 'nothing stands there' }] }, isError: true }),
    });
    const result = (answered as { result: { content: { type: string; text: string }[]; isError: boolean } }).result;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: false, refusals: [{ field: 'id', reason: 'nothing stands there' }] }) }]);
  });

  test('a served stream answers line by line, reports a line that is no message, and a last message with no newline', async () => {
    const written: string[] = [];
    async function* input(): AsyncGenerator<string> {
      yield '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
      yield 'not json\n{"jsonrpc":"2.0","id":2,"met';
      yield 'hod":"ping"}';
    }
    await serveUnitMcp({ call: async () => ({ answer: {}, isError: false }), streams: { input: input(), write: (text) => written.push(text) } });
    expect(written.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: expect.stringContaining('is no JSON-RPC message') } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The session: what one unit reads and writes through
// ---------------------------------------------------------------------------------------------

describe('one unit\'s tools, bound to its session', () => {
  test('a read is answered from the published graph and recorded as the unit\'s dependency', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const answered = await openedWorld.call(handle, 'neighbors', { id: openedWorld.graph.target.id });
    expect(answered.isError).toBe(false);
    const answer = answered.answer as { rows: { neighbor: { label: string } }[]; reads: { read: string; digest: string }[]; draft: unknown[] };
    expect(answer.rows.map((row) => row.neighbor.label)).toEqual([
      `${REPOSITORY}:${FILE}#OrderService.Zed`,
      `${REPOSITORY}:${FILE}#OrderService.alpha`,
      `${REPOSITORY}:${FILE}#OrderService.beta`,
    ]);
    // The three reads of one answer, in the order it made them: the edges, the nodes at their other ends,
    // and the drafts of the run. Each was recorded as this generation's dependency, and the answer names each
    // by the digest the orchestrator recorded it under.
    expect(answer.reads.map((read) => read.read)).toEqual(['adjacent', 'facts', 'drafts']);
    const recorded = await readUnitReads(openedWorld.owner, UNIT.unitId, UNIT.generation);
    const kinds = recorded.map((read) => (JSON.parse(read.query) as { read: string }).read);
    expect(kinds.slice(kinds.length - 3)).toEqual(['adjacent', 'facts', 'drafts']);
    const draftRead = recorded.filter((read) => (JSON.parse(read.query) as { read: string }).read === 'drafts').at(-1)!;
    // One draft set of the run stands about this node: the other unit's claim about it.
    expect(draftRead.members).toBe(1);
    expect(answer.reads.map((read) => read.digest)).toEqual(recorded.slice(recorded.length - 3).map((read) => read.queryDigest));
  });

  test('another unit\'s draft is shown as a draft beside the published rows and never mixed into them', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const answered = await openedWorld.call(handle, 'claims_about', { id: openedWorld.graph.target.id });
    const answer = answered.answer as { rows: unknown[]; draft: { asDraft: boolean; unit: string; generation: number; scope: string; write: string; evidence: string; fact: { kind: string; value: { text?: string } } }[] };
    // No published claim stands in the fixture, so every claim of this answer is a draft of another unit's.
    expect(answer.rows).toEqual([]);
    expect(answer.draft.map((row) => [row.asDraft, row.unit, row.generation, row.write])).toEqual([[true, 'agent/unit-b', 1, 'fact']]);
    expect(answer.draft[0]!.fact.value.text).toBe('The order total is the checkout total');
    expect(answer.draft[0]!.scope).toBe(`${REPOSITORY}:src`);
    expect(answer.draft[0]!.evidence).toBe(`${REPOSITORY}@${openedWorld.commit}:${FILE}`);
    // The draft of another run is not this unit's business: 0027's run is the working set.
    expect(answer.draft.some((row) => row.unit === 'agent/unit-c')).toBe(false);
  });

  test('a scope\'s drafts are the writes that stand inside it, and its published facts answer as they did', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const answered = await openedWorld.call(handle, 'describe_scope', { scope: openedWorld.graph.file.id });
    const answer = answered.answer as { holds: { kind: string; count: number }[]; draft: { unit: string; fact: { kind: string } }[] };
    expect(answer.holds).toEqual([{ kind: 'symbol', count: 4 }]);
    expect(answer.draft.map((row) => [row.unit, row.fact.kind])).toEqual([['agent/unit-b', 'claim']]);
  });

  test('an answer over the unit\'s own cap is cut and says what it cut', async () => {
    const openedWorld = opened();
    // 0026's 8K-token cap, narrowed to a number this test can reach: the cap is the unit's own.
    const handle = await openedWorld.tools(UNIT, { answerTokens: 120 });
    const answered = await openedWorld.call(handle, 'neighbors', { id: openedWorld.graph.target.id });
    const answer = answered.answer as { truncated: boolean; marker: string | null; tokens: number; rows: unknown[] };
    expect(answer.truncated).toBe(true);
    expect(answer.marker).toContain('truncated:');
    expect(answer.marker).toContain('120-token cap');
    expect(answer.rows.length).toBeLessThan(3);
  });

  test('evidence_span answers the pinned commit\'s bytes, which is the only way this unit reads code', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const answered = await openedWorld.call(handle, 'evidence_span', { repository: REPOSITORY, commit: openedWorld.commit, file: FILE, startLine: 2, endLine: 3 });
    expect(answered.isError).toBe(false);
    expect((answered.answer as { lines: { line: number; text: string }[] }).lines).toEqual([
      { line: 2, text: 'export const line2 = 2;' },
      { line: 3, text: 'export const line3 = 3;' },
    ]);
    // The bytes are the commit's own: a span pinned at another commit is refused by name.
    const wrong = await openedWorld.call(handle, 'evidence_span', { repository: REPOSITORY, commit: 'd'.repeat(40), file: FILE });
    expect(wrong.isError).toBe(true);
    expect(JSON.stringify(wrong.answer)).toContain(`is pinned at ${openedWorld.commit}`);
  });
});

describe('one unit\'s writes, bound to its session', () => {
  test('an accepted write lands in the unit\'s own draft set, and the answer names the fact and its place in the set', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const answered = await openedWorld.call(handle, 'assert_fact', {
      kind: 'claim',
      value: { subject: { form: 'node', id: openedWorld.graph.target.id }, predicate: 'returns-the-order-total', object: { form: 'literal', text: 'the order total' } },
      place: { repository: REPOSITORY, file: FILE, startLine: 40 },
    });
    expect(answered.isError).toBe(false);
    const landed = answered.answer as { ok: true; fact: { id: string; kind: string; layer: string; status: string }; position: number; evidence: string };
    expect(landed.fact.kind).toBe('claim');
    // 0026 and 0005: an agent's statement is inferred and proposed, never accepted by the writing.
    expect([landed.fact.layer, landed.fact.status]).toEqual(['inferred', 'proposed']);
    expect(landed.position).toBe(1);
    expect(landed.evidence).toBe(`${REPOSITORY}@${openedWorld.commit}:${FILE}`);
    const draft = await readUnitDraft(openedWorld.owner, UNIT.unitId, UNIT.generation);
    expect(draft?.writes.map((write) => (write.value as { id: string }).id)).toEqual([landed.fact.id]);
  });

  test('a write that cites a place outside the unit\'s scope is refused, naming the scope and the place', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const before = (await readUnitDraft(openedWorld.owner, UNIT.unitId, UNIT.generation))?.writes.length ?? 0;
    const answered = await openedWorld.call(handle, 'raise_question', {
      type: 'assumption-check',
      prompt: 'Is the README the only document?',
      place: { repository: REPOSITORY, file: OTHER_FILE, startLine: 1 },
    });
    expect(answered.isError).toBe(true);
    const refusal = (answered.answer as { ok: false; refusals: { field: string; reason: string; file?: string }[] }).refusals[0]!;
    expect(refusal.field).toBe('place.file');
    expect(refusal.reason).toContain(`the unit's scope is "${REPOSITORY}:src"`);
    expect(refusal.reason).toContain(`"${OTHER_FILE}"`);
    // Nothing landed: a refused write is never stored, not even in part — the set holds what it held.
    const held = await readUnitDraft(openedWorld.owner, UNIT.unitId, UNIT.generation);
    expect(held?.writes.length ?? 0).toBe(before);
  });

  test('a write that cites a file the pinned commit does not hold is refused by the reader\'s own words', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const answered = await openedWorld.call(handle, 'assert_fact', {
      kind: 'rule',
      value: { repository: REPOSITORY, form: 'invariant', statement: 'The total is never negative' },
      place: { repository: REPOSITORY, file: 'src/absent.ts', startLine: 1 },
    });
    expect(answered.isError).toBe(true);
    expect(JSON.stringify(answered.answer)).toContain('src/absent.ts');
  });
});

describe('the token, and the host it names', () => {
  test('a token no open session holds answers nothing, and the route refuses it', async () => {
    const openedWorld = opened();
    // A host of its own knows no token at all: this is the registry's answer, not the service's.
    const host = createUnitToolsHost();
    expect(await host.call({ token: 'not-a-token', tool: 'neighbors', arguments: { id: openedWorld.graph.target.id } })).toBeNull();
    expect(await openedWorld.service.unitTool({ token: 'not-a-token', tool: 'neighbors' })).toBeNull();
    const response = await fetch(`${openedWorld.server.url}${UNIT_TOOL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-token', tool: 'neighbors', arguments: { id: openedWorld.graph.target.id } }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { field: 'token' } });
  });

  test('a session closed for its unit answers nothing afterwards, so a server left running cannot act for it', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const token = tokenOf(handle);
    expect((await openedWorld.call(handle, 'coverage', { scope: `${REPOSITORY}:src` })).isError).toBe(false);
    handle.close();
    // The service the route and the tools share is the one that forgets the token: a closed unit's server
    // answers nothing at all, which the route reports as a refusal rather than as a tool's answer.
    expect(await openedWorld.service.unitTool({ token, tool: 'coverage', arguments: { scope: `${REPOSITORY}:src` } })).toBeNull();
  });

  test('the server a handler describes is this build\'s own program with the session\'s token in its environment', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const server = handle.mcpServer as Extract<AcpMcpServer, { command: string }>;
    expect(server.name).toBe('madarch-unit');
    expect(server.command.length).toBeGreaterThan(0);
    // From a checkout this build's command is `bun scripts/madarch.ts mcp-unit`; from the release binary it is the
    // binary itself with the same word (selfCommand, the daemon's own measurements).
    expect(server.args?.at(-1)).toBe('mcp-unit');
    expect(server.env?.[UNIT_TOOL_URL_VARIABLE]).toBe(`${openedWorld.server.url}/api/fill/unit/tool`);
    expect(String(server.env?.[UNIT_TOOL_TOKEN_VARIABLE]).length).toBeGreaterThan(0);
  });

  test('the started server refuses to run without its host\'s address or its session\'s token', () => {
    expect(unitToolEnvironment({})).toContain(UNIT_TOOL_URL_VARIABLE);
    expect(unitToolEnvironment({ [UNIT_TOOL_URL_VARIABLE]: 'http://127.0.0.1:1/api/fill/unit/tool' })).toContain(UNIT_TOOL_TOKEN_VARIABLE);
    expect(unitToolEnvironment({ [UNIT_TOOL_URL_VARIABLE]: 'http://127.0.0.1:1/api/fill/unit/tool', [UNIT_TOOL_TOKEN_VARIABLE]: 'x' })).toEqual({ url: 'http://127.0.0.1:1/api/fill/unit/tool', token: 'x' });
  });

  test('a host that a unit\'s server cannot reach is a tool failure the agent reads, never a hung call', async () => {
    const busy = unitToolProxy({ url: 'http://127.0.0.1:9/api/fill/unit/tool', token: 't', timeoutMs: 500 });
    const unreachable = await busy('neighbors', { id: 'symbol:' + 'a'.repeat(64) });
    expect(unreachable.isError).toBe(true);
    expect(JSON.stringify(unreachable.answer)).toContain('could not be answered at http://127.0.0.1:9/api/fill/unit/tool');
    const refused = unitToolProxy({
      url: 'http://127.0.0.1:9/api/fill/unit/tool',
      token: 't',
      fetch: (async () => new Response('{"error":{"message":"no open unit session holds this token"}}', { status: 401 })) as unknown as typeof fetch,
    });
    const refusedAnswer = await refused('neighbors', {});
    expect(refusedAnswer.isError).toBe(true);
    expect(JSON.stringify(refusedAnswer.answer)).toContain('the host answered 401');
    const broken = unitToolProxy({
      url: 'http://127.0.0.1:9/api/fill/unit/tool',
      token: 't',
      fetch: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    });
    expect(JSON.stringify((await broken('neighbors', {})).answer)).toContain('the host\'s answer is no JSON');
  });
});

// ---------------------------------------------------------------------------------------------
// The session an agent is given: the fake ACP agent calls a tool through it
// ---------------------------------------------------------------------------------------------

describe('an agent reaches the store through the unit\'s server', () => {
  let connection: AcpConnection | undefined;
  const scratch: string[] = [];

  afterAll(async () => {
    await connection?.close().catch(() => undefined);
    connection = undefined;
    for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  test('the fake agent\'s neighbors call reaches the store and its answer comes back in the session', async () => {
    const openedWorld = opened();
    const handle = await openedWorld.tools();
    const folder = mkdtempSync(join(tmpdir(), 'madarch-unit-agent-'));
    scratch.push(folder);
    const record = join(folder, 'record.jsonl');
    writeFileSync(record, '');
    connection = await connectAcpAgent(
      { id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'mcp-tools', '--record', record] },
      { cwd: process.cwd(), sessionTimeoutMs: 60_000 },
    );
    await connection.initialize();
    // The unit's own server, as `startServer`'s route serves it: the session is created with it attached and
    // with no file tool of the agent's own (the client advertises none, `src/fill/acp.ts`).
    const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [handle.mcpServer] });
    const asked = { tool: 'neighbors', arguments: { id: openedWorld.graph.target.id } };
    const turn = await session.prompt(JSON.stringify(asked));
    expect(turn.stopReason).toBe('end_turn');
    const reported = JSON.parse(turn.text) as { tool: string; isError: boolean; text: string; tools: string[] };
    expect(reported.tool).toBe('neighbors');
    expect(reported.isError).toBe(false);
    // The ten tools of 0026 were listed to the agent, in the catalogue's order.
    expect(reported.tools).toEqual([...UNIT_TOOL_NAMES]);
    const answer = JSON.parse(reported.text) as { rows: { neighbor: { label: string } }[]; reads: { read: string }[] };
    expect(answer.rows.map((row) => row.neighbor.label)).toEqual([
      `${REPOSITORY}:${FILE}#OrderService.Zed`,
      `${REPOSITORY}:${FILE}#OrderService.alpha`,
      `${REPOSITORY}:${FILE}#OrderService.beta`,
    ]);
    // The call reached the store as this unit's dependency: the orchestrator's own row for it.
    const recorded = await readUnitReads(openedWorld.owner, UNIT.unitId, UNIT.generation);
    expect(recorded.map((read) => read.query).some((query) => query.includes('"read":"adjacent"'))).toBe(true);
    // The session was created with the unit's server, which the agent started: the protocol's own shape.
    const sessionRequest = readFileSync(record, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { method?: string; params?: { mcpServers?: { name?: string }[] } }).find((message) => message.method === 'session/new');
    expect(sessionRequest?.params?.mcpServers?.map((server) => server.name)).toEqual(['madarch-unit']);
  }, 120_000);
});
