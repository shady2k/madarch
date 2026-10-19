/**
 * One agent unit inside its limits, from end to end (madarch-tzte.22.3; decisions
 * 0026 and 0027): a unit receives the fixed part and a packet of at most 20K tokens
 * assembled from the graph, is warned at 70% of 0026's 272K window, stopped at 80%,
 * stopped at 0026's ~30 turns and ~10 minutes, returns its partial result with its
 * coverage, and the orchestrator splits its scope and runs the parts. A unit that
 * finishes within its limits publishes its draft set.
 *
 * Every expectation is taken from the task and the decisions: 0026's numbers, the
 * answer contract the packet asks for, the two child scopes a split names, and 0027's
 * own publication and split semantics. The agent is the fake ACP agent of
 * `test/fixtures/acp-fake-agent` (no real prompt, no network, no token spent), the
 * MCP server is the real one of madarch-tzte.22.2 answering through the real server
 * route, and time passes through a seam, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts, FACT_APPLICATION } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFactGraphReader, estimateTokens, DEFAULT_GRAPH_READ_LIMITS } from '../src/fill/graph-reads.js';
import { draftSetOf } from '../src/fill/checked-writes.js';
import { createFillOrchestratorService, type FillOrchestratorService, type ProductFillWiring } from '../src/fill/orchestrator-host.js';
import {
  createOrchestrator,
  planRun,
  schedulerPass,
  startRun,
  sweepUnits,
  workOnce,
  type FillOrchestrator,
} from '../src/fill/orchestrator.js';
import { createOrchestratorSchema, readProgress, readUnitDraft, readUnitReads, type RunSnapshot } from '../src/fill/orchestrator-store.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { AGENT_UNIT_STAGE_ID, createAgentUnitStage } from '../src/fill/stages/agent-unit.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { FACT_KINDS } from '../src/fill/facts.js';
import { Type } from 'typebox';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readRunUnits, readUnit } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { QueueService } from '../src/fill/queue.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-2026-10-19T03:00Z';
const REPOSITORY = 'acme-shop';
/** The places the repository holds: three folders, each with one file of the pinned commit. */
const FOLDERS = ['a', 'b', 'c'];
const FOLDER_FILES: Record<string, string> = { a: 'a/one.ts', b: 'b/one.ts', c: 'c/one.ts' };
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let root: string | undefined;
let COMMIT = 'a'.repeat(40);
/** The pid the fake agent writes and its record file, per world: read by the tests that assert what the agent saw. */
let world: World | undefined;

function provenance(file: string, line: number): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: REPOSITORY, commit: COMMIT },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/** The graph the run fills: one repository, three folders, a file in each, and the edges that place them. */
interface Graph {
  readonly repository: Fact;
  readonly folders: readonly Fact[];
  readonly files: readonly Fact[];
  facts(): readonly Fact[];
}

function fixture(): Graph {
  const repository = makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('README.md', 1), layer: 'extracted' });
  const folders = FOLDERS.map((folder) => makeNodeFact({ kind: 'directory', value: { repository: REPOSITORY, path: repositoryPath(folder) }, provenance: provenance(`${folder}/one.ts`, 1), layer: 'extracted' }));
  const files = FOLDERS.map((folder) => makeNodeFact({
    kind: 'file',
    value: { repository: REPOSITORY, path: repositoryPath(FOLDER_FILES[folder]!), roles: ['source'], language: 'typescript', bytes: 24, blob: 'b'.repeat(40) },
    provenance: provenance(FOLDER_FILES[folder]!, 1),
    layer: 'extracted',
  }));
  return {
    repository,
    folders,
    files,
    facts: () => [
      repository, ...folders, ...files,
      ...folders.map((folder) => makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: folder.id }, provenance: provenance('README.md', 1), layer: 'extracted' })),
      ...files.map((file, index) => makeEdgeFact({ kind: 'contains', value: { from: folders[index]!.id, to: file.id }, provenance: provenance(FOLDER_FILES[FOLDERS[index]!]!, 1), layer: 'extracted' })),
    ],
  };
}

/**
 * The stand-in for the deterministic stages this fixture publishes the facts of: it
 * declares the capabilities the agent unit consumes (`repository`, `file`,
 * `coverage`) so the derived stage graph knows where the agent unit's inputs come
 * from, and it plans no unit, because the graph is already published.
 */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'file', 'coverage'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'file'].version, scope: 'repository' as const })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: () => ({ units: [] }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
  };
}

/** One world: a database with the fill's tables and the fixture graph, an orchestrator, the service that answers a unit's tool calls, and the fake agent's own script. */
interface World {
  readonly owner: DatabaseOwner;
  readonly graph: Graph;
  readonly orchestrator: FillOrchestrator;
  readonly service: FillOrchestratorService;
  readonly server: StartedServer;
  readonly queue: QueueService;
  readonly record: string;
  /** What the fake agent was sent, in the order it received it: one JSON object per line. */
  sent(): readonly Record<string, unknown>[];
  close(): Promise<void>;
}

/** What one world is opened with. */
interface WorldOptions {
  /** The steps the fake agent follows, per prompt, and the steps every other prompt follows. */
  readonly script: { readonly byPrompt: readonly { readonly matches: string; readonly steps: readonly unknown[] }[]; readonly steps: readonly unknown[] };
  /** The clock the run and the unit limits read; a constant unless a test moves it. */
  readonly clock?: () => number;
  /** The orchestrator's own limits, where a test holds them still (a jumpy clock against a short lease). */
  readonly limits?: Parameters<typeof createOrchestrator>[0]['limits'];
}

async function openWorld(options: WorldOptions): Promise<World> {
  const name = `world-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
  const folder = join(root!, name);
  mkdirSync(folder, { recursive: true });
  const scriptPath = join(folder, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(options.script));
  const record = join(folder, 'agent-record.jsonl');
  const clock = options.clock ?? (() => NOW);

  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', leaseSeconds: 3_600, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });

  const graph = fixture();
  await createUnit(owner, { unitId: 'graph/all', product: PRODUCT, runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const record0 = await readUnit(owner, 'graph/all');
  if (record0 === null) throw new Error('the fixture unit was not created');
  await owner.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: record0,
    plan: { unitId: 'graph/all', generation: record0.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: 'graph-publication-1',
    writes: graph.facts().map((fact) => ({ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMIT}`, value: fact })),
  }));

  const pins: readonly RepositoryPin[] = [{ id: REPOSITORY, form: 'code', root: join(root!, REPOSITORY), commit: COMMIT }];
  const snapshots = createGitSnapshotSource(() => pins);
  const snapshot: RunSnapshot = { repository: 'example.invalid/acme/shop', defaultBranch: 'main', commit: COMMIT, registryHash: 'sha256:registry' };
  const wiring: ProductFillWiring = {
    snapshot: () => snapshot,
    configuration: () => undefined,
    graph: () => createFactGraphReader({ database: owner, snapshot: snapshots }),
    inputs: () => ({}),
    source: () => snapshots,
  };
  // The run's stages: the agent unit's own, and one stand-in for the deterministic stages whose published facts this
  // fixture's graph is (0026's stages 0 to 7) — it plans no unit of its own, so the run has exactly the agent unit to
  // work. Its capabilities are the kinds the agent unit consumes, so the derived graph is not starved.
  const registry = new StageRegistry()
    .register(structureStage())
    .register(createAgentUnitStage({
      snapshots,
      agent: { id: 'fake-agent', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', scriptPath, '--record', record] },
      clock,
      cwd: folder,
      timeouts: { initializeMs: 30_000, sessionMs: 30_000 },
    }));

  let server: StartedServer | undefined;
  const service = createFillOrchestratorService({
    home: join(folder, 'products'),
    registry,
    owner,
    wiring: () => wiring,
    queueFactory: async () => queue,
    toolUrl: () => (server === undefined ? undefined : `${server.url}${UNIT_TOOL_PATH}`),
  });
  const appFolder = join(folder, 'app');
  mkdirSync(appFolder, { recursive: true });
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>fixture app</title>');
  const home = join(folder, 'home');
  mkdirSync(home, { recursive: true });
  // Port 0: the server names a free one, and nothing here takes another process's port.
  server = await startServer({ productHome: home, appFolder, port: 0, orchestrator: service, log: () => undefined, errorLog: () => undefined });

  const orchestrator = createOrchestrator({
    database: owner,
    registry,
    queue,
    queueName: 'fill-units',
    product: PRODUCT,
    configuration: () => undefined,
    snapshot: () => snapshot,
    // The publication's recheck reads inside the publication's own transaction (0027), so this reader borrows the
    // executor it is handed rather than opening a second transaction on the owner's one connection.
    graph: async (ref, transaction) => createFactGraphReader({ database: owner, snapshot: snapshots, ...(transaction === undefined ? {} : { executor: transaction }) }),
    inputs: () => ({}),
    facts: FACT_APPLICATION,
    clock,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    // The unit's own MCP server, opened by the host that owns the database and answers its calls (0026, "Agents and
    // tools"): the same seam the service wires for the daemon.
    unitTools: async (opening) => await service.unitTools({
      product: { name: PRODUCT, folder: home },
      unit: { unitId: opening.unit.unitId, generation: opening.unit.generation },
      url: `${server!.url}${UNIT_TOOL_PATH}`,
      draft: draftSetOf(opening.draft),
    }),
  });

  return {
    owner,
    graph,
    orchestrator,
    service,
    server,
    queue,
    record,
    sent: () => {
      const text = readFileSync(record, 'utf8');
      return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    close: async () => {
      await server!.stop();
      await service.stop();
      await queue.stop().catch(() => undefined);
      await owner.close();
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-agent-unit-'));
  const checkout = join(root, REPOSITORY);
  for (const folder of FOLDERS) {
    mkdirSync(join(checkout, folder), { recursive: true });
    writeFileSync(join(checkout, FOLDER_FILES[folder]!), `export const ${folder} = '${folder}';\nexport const ${folder}Second = 2;\n`);
  }
  writeFileSync(join(checkout, 'README.md'), '# acme shop\n');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'one');
  COMMIT = git('rev-parse', 'HEAD').trim();
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** Plans and admits the run's single unit, and returns the unit the plan made. */
async function planAndAdmit(opened: World): Promise<{ unitId: string; generation: number }> {
  const started = await startRun(opened.orchestrator, { runId: RUN });
  expect(started.ok).toBe(true);
  const planned = await planRun(opened.orchestrator, { runId: RUN });
  if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
  const pass = await schedulerPass(opened.orchestrator, { runId: RUN });
  expect(pass.admitted).toBe(planned.units.length);
  const unit = planned.units[0]!;
  expect(planned.units.map((planned_) => planned_.stageId)).toEqual([AGENT_UNIT_STAGE_ID]);
  return { unitId: unit.unitId, generation: unit.generation };
}

/** The prompt texts the fake agent was sent, in order. */
function prompts(opened: World): readonly string[] {
  return opened.sent()
    .filter((message) => message['method'] === 'session/prompt')
    .map((message) => String(((message['params'] as { prompt?: { text?: string }[] }).prompt ?? [])[0]?.text ?? ''));
}

describe('one agent unit, end to end', () => {
  test('a unit that finishes within its limits is warned at 70% and publishes its draft set', async () => {
    // The agent reads one span of the pinned bytes through its MCP server, crosses 70% of the window, is told to wrap
    // up, and answers: 0026's "a unit that finishes within its limits publishes its draft set".
    const opened = await openWorld({
      script: {
        // The unit crosses 70% in its first turn and ends it without an answer, so the wrap-up message is the turn
        // that follows; in that turn it reads one span of the pinned bytes through its MCP server and answers.
        byPrompt: [{ matches: 'wrap-up:', steps: [
          { call: { tool: 'evidence_span', arguments: { repository: REPOSITORY, commit: COMMIT, file: 'a/one.ts', startLine: 1, endLine: 2 } } },
          { answer: { status: 'done', covered: ['a', 'b', 'c'], remaining: [], summary: 'The three folders each hold one file' } },
        ] }],
        steps: [
          { say: 'reading the scope' },
          { usage: { used: 200_000, size: 272_000 } },
          { end: {} },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      expect(worked.unitId).toBe(unit.unitId);

      // The prompt the agent received: the fixed part and the packet, within 0026's 20K tokens.
      const sent = prompts(opened);
      expect(sent.length).toBe(2);
      const packetPrompt = sent[0]!;
      expect(packetPrompt).toContain('You are one unit of madarch\'s fill');
      expect(packetPrompt).toContain('a 272000-token context window');
      expect(packetPrompt).toContain('"scope": "acme-shop"');
      expect(packetPrompt).toContain(`"id": "${opened.graph.repository.id}"`);
      expect(estimateTokens(packetPrompt, DEFAULT_GRAPH_READ_LIMITS)).toBeLessThanOrEqual(20_000);
      // 70% earns the wrap-up message as the unit's own next turn, and it names what it spent.
      expect(sent[1]).toContain('wrap-up:');
      expect(sent[1]).toContain('200000 of its 272000-token window');
      expect(sent[1]).toContain('73.5%');
      // 0026: the agent's own file tools are off and its reads go through the session's server, so the span it read
      // is a recorded dependency of the unit.
      const reads = await readUnitReads(opened.owner, unit.unitId, unit.generation);
      expect(reads.filter((read) => (JSON.parse(read.query) as { read: string }).read === 'span').length).toBe(1);

      // Its draft set is published in one transaction (0027): the coverage of what it read.
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      expect(draft?.writes.length).toBe(1);
      expect(draft?.writes[0]?.kind).toBe('fact');
      const fact = draft?.writes[0]?.value as { kind: string; value: { scope: string; complete: boolean; read: string[]; unread: unknown[] } };
      expect(fact.kind).toBe('coverage');
      expect(fact.value.scope).toBe(opened.graph.repository.id);
      expect(fact.value.complete).toBe(true);
      expect(fact.value.read).toEqual(['a', 'b', 'c']);
      expect(fact.value.unread).toEqual([]);
      const factId = (draft!.writes[0]!.value as { id: string }).id;
      const published = await opened.owner.transaction('snapshot', async (executor) => (await executor.query<{ count: number }>('SELECT count(*)::int AS count FROM fill_fact WHERE id = $1', [factId])).rows[0]?.count ?? 0);
      expect(published).toBe(1);
      const after = await readRunUnits(opened.owner, RUN);
      expect(after.map((record) => record.state)).toEqual(['published']);
    } finally {
      await opened.close();
    }
  }, 120_000);

  test('a unit driven past 80% is cancelled, keeps its partial draft and coverage, and splits into two children that run', async () => {
    // The graph's ids are the fixture's own (0026: ids are stable and carry no run): the parent's branch keys on the
    // repository's fact id, which its packet carries as the unit it runs, and each child's on its own folder.
    const ids = fixture();
    const [firstFolder, secondFolder, thirdFolder] = ids.folders;
    const parentSteps = [
      { say: 'reading the scope' },
      { usage: { used: 100_000, size: 272_000 } },
      { call: { tool: 'evidence_span', arguments: { repository: REPOSITORY, commit: COMMIT, file: 'a/one.ts', startLine: 1, endLine: 2 } } },
      { call: { tool: 'raise_question', arguments: { type: 'assumption-check', prompt: 'Which folder owns the total?', place: { repository: REPOSITORY, file: 'a/one.ts', startLine: 1, endLine: 1 } } } },
      { usage: { used: 190_400, size: 272_000 } },
      // 80% of 0026's window: the unit is stopped here, and the turn in flight is cancelled.
      { usage: { used: 220_000, size: 272_000 } },
      { wait: true },
    ];
    const childSteps = (file: string): readonly unknown[] => [
      { say: 'reading the child scope' },
      { call: { tool: 'evidence_span', arguments: { repository: REPOSITORY, commit: COMMIT, file, startLine: 1, endLine: 2 } } },
      { answer: { status: 'done', covered: [file], remaining: [], summary: 'the child folder was read' } },
    ];
    const opened = await openWorld({
      script: {
        byPrompt: [
          { matches: ids.repository.id, steps: parentSteps },
          { matches: secondFolder!.id, steps: childSteps('b/one.ts') },
          { matches: thirdFolder!.id, steps: childSteps('c/one.ts') },
        ],
        steps: [],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      // The parent's prompt names the scope node it covers, which is the repository: its branch keys on that id.
      expect(unit.unitId).toBe(`${AGENT_UNIT_STAGE_ID}/${ids.repository.id}`);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('split');

      // 0026's hard stop: the turn in flight was cancelled through the protocol, after 80% of the window.
      expect(opened.sent().filter((message) => message['method'] === 'session/cancel').length).toBe(1);
      expect(prompts(opened)[0]).toContain(`"id": "${ids.repository.id}"`);

      // The parent stands waiting for its children, with the places it did not cover as the children's scopes.
      const units = await readRunUnits(opened.owner, RUN);
      expect(units.find((record) => record.unitId === unit.unitId)?.state).toBe('waiting_children');
      const children = units.filter((record) => record.unitId !== unit.unitId);
      expect(children.map((record) => record.state)).toEqual(['planned', 'planned']);
      // The two places the parent did not cover, one child each, named by their own folder's fact id.
      expect(children.map((record) => record.unitId).sort()).toEqual([
        `${AGENT_UNIT_STAGE_ID}/${secondFolder!.id}`,
        `${AGENT_UNIT_STAGE_ID}/${thirdFolder!.id}`,
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));

      // Its partial draft is recorded with the coverage: what the unit established before it stopped, and the
      // places it did not read, each a `budget` gap (0026: "returns what it has with its coverage").
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const writes = draft?.writes ?? [];
      expect(writes.length).toBe(2);
      expect((writes[0]!.value as { kind: string }).kind).toBe('question');
      const coverage = writes[1]!.value as { kind: string; value: { complete: boolean; read: string[]; unread: { what: string; reason: string }[] } };
      expect(coverage.kind).toBe('coverage');
      expect(coverage.value.complete).toBe(false);
      expect(coverage.value.read).toEqual(['a']);
      expect(coverage.value.unread).toEqual([{ what: 'b', reason: 'budget' }, { what: 'c', reason: 'budget' }]);
      void firstFolder;

      // The orchestrator runs the parts: each child reads its own scope and publishes. The stage's declared
      // concurrency is one unit at a time (0027's stage configuration), so a pass admits the next child as the
      // one before it publishes.
      const results: (string | undefined)[] = [];
      for (let pass = 0; pass < 4 && results.length < 2; pass += 1) {
        await schedulerPass(opened.orchestrator, { runId: RUN });
        const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
        if (worked.claimed) results.push(worked.result);
      }
      expect(results).toEqual(['published', 'published']);
      for (const child of await readRunUnits(opened.owner, RUN)) {
        if (child.unitId === unit.unitId) continue;
        expect(child.state).toBe('published');
        const childDraft = await readUnitDraft(opened.owner, child.unitId, child.generation);
        expect((childDraft?.writes[0]?.value as { kind: string }).kind).toBe('coverage');
      }
      // The children published and are fresh, so the waiting parent joins and is runnable again (0027's join).
      const swept = await sweepUnits(opened.orchestrator, { runId: RUN });
      expect(swept.refused).toEqual([]);
      expect(swept.swept.map((entry) => [entry.unitId, entry.outcome])).toEqual([[unit.unitId, 'join-enqueued']]);
      expect((await readRunUnits(opened.owner, RUN)).find((record) => record.unitId === unit.unitId)?.state).toBe('ready');
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a unit that never answers is stopped at 0026\'s turn limit and splits what it did not cover', async () => {
    const opened = await openWorld({
      // Every turn ends without the answer the unit contract asks for, so the unit is nudged until 0026's turn limit.
      script: { byPrompt: [], steps: [{ say: 'still reading' }, { end: {} }] },
      limits: { leaseMs: 86_400_000 },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('split');
      // 0026: "at most ~30 turns". The unit was asked once per turn and stopped at the thirtieth.
      expect(prompts(opened).length).toBe(30);
      const stopped = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its turn limit'));
      expect(stopped.length).toBe(1);
      expect(stopped[0]).toContain('stopped at its turn limit: 30 of 30 turns');
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const coverage = draft?.writes[0]?.value as { kind: string; value: { complete: boolean; read: string[]; unread: { what: string; reason: string }[] } };
      expect(coverage.kind).toBe('coverage');
      expect(coverage.value.complete).toBe(false);
      expect(coverage.value.read).toEqual([]);
      expect(coverage.value.unread.map((gap) => gap.what)).toEqual(['a', 'b', 'c']);
      expect(coverage.value.unread.every((gap) => gap.reason === 'budget')).toBe(true);
      // Every place it did not cover is a child unit's own scope.
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unit.unitId);
      expect(children.length).toBe(3);
      expect(children.every((record) => record.state === 'planned')).toBe(true);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a unit whose clock passes ten minutes is stopped at its time limit, through the seam and with no wait', async () => {
    let at = NOW;
    const opened = await openWorld({
      script: { byPrompt: [], steps: [{ say: 'reading' }, { usage: { used: 1_000, size: 272_000 } }, { end: {} }] },
      clock: () => { at += 150_000; return at; },
      // A clock that jumps three minutes at a time would lapse the orchestrator's own lease: this test holds the
      // lease still so the limit it measures is the unit's, not the sweep's.
      limits: { leaseMs: 86_400_000 },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('split');
      // 0026: "~10 minutes", read from the clock this test moves by hand: the run's own progress says which limit
      // the unit stopped at, and nothing waited.
      const stopped = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its time limit'));
      expect(stopped.length).toBe(1);
      expect(stopped[0]).toContain('stopped at its time limit:');
      expect(stopped[0]).toContain('of 600 seconds');
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const coverage = draft?.writes.at(-1)?.value as { kind: string; value: { complete: boolean } };
      expect(coverage.kind).toBe('coverage');
      expect(coverage.value.complete).toBe(false);
    } finally {
      await opened.close();
    }
  }, 180_000);
});

describe('registering the agent unit stage', () => {
  test('a run that wires an agent registers the stage; a run that wires none holds no unit that could read nothing', () => {
    const snapshots = createGitSnapshotSource(() => []);
    // A run with no agent: 0026's agent units are a session with an agent, so a stage registered without one would
    // plan units that could not run.
    expect(createStageRegistry({ snapshots }).all().map((stage) => stage.id)).not.toContain(AGENT_UNIT_STAGE_ID);
    const wired = createStageRegistry({ snapshots, agent: { agent: { id: 'fake-agent', command: 'bun' } } });
    expect(wired.get(AGENT_UNIT_STAGE_ID)?.usesTools).toBe(true);
    // It declares the kinds 0026's agent units write, each with the schema's own version.
    expect(wired.get(AGENT_UNIT_STAGE_ID)?.produces.map((produced) => produced.kind)).toEqual(['claim', 'coverage', 'entity-proposal', 'question', 'rule', 'state']);
    expect(wired.get(AGENT_UNIT_STAGE_ID)?.produces.every((produced) => produced.schemaVersion === FACT_KINDS[produced.kind as 'claim'].version)).toBe(true);
  });
});
