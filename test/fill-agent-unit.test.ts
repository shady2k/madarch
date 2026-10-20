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
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts, FACT_APPLICATION, readUnitFacts } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFactGraphReader, estimateTokens, DEFAULT_GRAPH_READ_LIMITS } from '../src/fill/graph-reads.js';
import { readPageModel } from '../src/fill/graph-pages.js';
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
import { MEMBER_ESTIMATE_TOKENS } from '../src/fill/agent-packet.js';
import {
  AGENT_UNIT_STAGE_ID,
  childrenOfPlaces,
  coveredOf,
  createAgentUnitStage,
  MAX_PLAN_UNITS,
  memberPlaces,
  planUnits,
  readUnitAnswer,
  type AgentPlace,
} from '../src/fill/stages/agent-unit.js';
import { OVERVIEW_STAGE_ID } from '../src/fill/stages/overview.js';
import { StageRegistry } from '../src/fill/registry.js';
import { writeScope } from '../src/fill/checked-writes.js';
import type { UnitPacket } from '../src/fill/agent-packet.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageDraftWrite, type StageGraphReader } from '../src/fill/stage.js';
import { FACT_KINDS } from '../src/fill/facts.js';
import { Type } from 'typebox';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readRunUnits, readUnit } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import type { UnitTimers } from '../src/fill/unit-limits.js';
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

function fixture(wide: readonly string[] = []): Graph {
  const repository = makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('README.md', 1), layer: 'extracted' });
  // `wide` adds folders the repository holds and nothing more: a scope whose member list is longer than the graph
  // read's own 8K-token cap answers, which is what a unit cannot enumerate from its packet.
  // A folder's own path is its value's, not its provenance's (`pathOfNode`, `agent-packet.ts`): a wide folder cites
  // the repository's README, which is a file of the pinned commit and no folder of its own.
  const folders = [...FOLDERS, ...wide].map((folder) => makeNodeFact({ kind: 'directory', value: { repository: REPOSITORY, path: repositoryPath(folder) }, provenance: provenance(FOLDERS.includes(folder) ? `${folder}/one.ts` : 'README.md', 1), layer: 'extracted' }));
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
  /** Folders the repository holds besides the fixture's three: a scope whose member list a read cannot enumerate. */
  readonly wide?: readonly string[];
  /** The timers a turn's watch is armed on: a test's fire at once, so the deadline arrives on the clock it moves. */
  readonly timers?: UnitTimers;
  /** Facts the graph holds beside the fixture's: a question a test asks the unit to answer, and nothing more. */
  readonly extraFacts?: readonly Fact[];
}

async function openWorld(options: WorldOptions): Promise<World> {
  // A scratch folder of its own per world, named by `mkdtemp` so two worlds never collide and the test names no
  // clock or random value of its own.
  const folder = mkdtempSync(join(root!, 'world-'));
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

  const graph = fixture(options.wide ?? []);
  await createUnit(owner, { unitId: 'graph/all', product: PRODUCT, runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const record0 = await readUnit(owner, 'graph/all');
  if (record0 === null) throw new Error('the fixture unit was not created');
  await owner.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: record0,
    plan: { unitId: 'graph/all', generation: record0.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: 'graph-publication-1',
    writes: [...graph.facts(), ...options.extraFacts ?? []].map((fact) => ({ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMIT}`, value: fact })),
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
      ...(options.timers === undefined ? {} : { timers: options.timers }),
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

/**
 * A timers seam that fires the watch as soon as it can: the deadline is the clock's to say, so a test moves that clock
 * by hand and the wait the watch asked for is never taken. The callback runs once the turn's prompt has gone out,
 * because a microtask is queued after the synchronous call that writes it.
 */
function instantTimers(): { readonly timers: UnitTimers; readonly waits: readonly number[] } {
  const waits: number[] = [];
  return {
    waits,
    timers: {
      setTimeout: (callback: () => void, ms: number): unknown => {
        waits.push(ms);
        queueMicrotask(callback);
        return waits.length;
      },
      clearTimeout: (): void => undefined,
    },
  };
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
      // is a recorded dependency of the unit — recorded as its place in the run's pins and the bytes it read, never
      // by the commit it read them at (0026, "Updates"; madarch-tzte.26.1): a recheck at the run's next pin compares
      // bytes with bytes, and a commit that leaves the span as it was is no change to this unit.
      const reads = await readUnitReads(opened.owner, unit.unitId, unit.generation);
      const spans = reads.filter((read) => (JSON.parse(read.query) as { read: string }).read === 'span');
      expect(spans.map((read) => JSON.parse(read.query))).toEqual([{ read: 'span', repository: REPOSITORY, file: 'a/one.ts', startLine: 1, endLine: 2 }]);
      expect(spans[0]!.members).toBe(1);

      // Its draft set is published in one transaction (0027): the coverage of what it read. A published set is
      // the store's own facts and no second copy of them (madarch-tzte.21.11), so it is read as published facts.
      const published = (await readUnitFacts(opened.owner, unit.unitId)).map((entry) => entry.fact);
      expect(published.length).toBe(1);
      const fact = published[0] as unknown as { kind: string; value: { scope: string; complete: boolean; read: string[]; unread: unknown[] } };
      expect(fact.kind).toBe('coverage');
      expect(fact.value.scope).toBe(opened.graph.repository.id);
      expect(fact.value.complete).toBe(true);
      expect(fact.value.read).toEqual(['a', 'b', 'c']);
      expect(fact.value.unread).toEqual([]);
      const factId = (published[0] as unknown as { id: string }).id;
      const stored = await opened.owner.transaction('snapshot', async (executor) => (await executor.query<{ count: number }>('SELECT count(*)::int AS count FROM fill_fact WHERE id = $1', [factId])).rows[0]?.count ?? 0);
      expect(stored).toBe(1);
      const after = await readRunUnits(opened.owner, RUN);
      expect(after.map((record) => record.state)).toEqual(['published']);
    } finally {
      await opened.close();
    }
  }, 120_000);

  test('a unit closes a question when it finds the answer with evidence, and the question\'s page shows the answer', async () => {
    // The self-filling charter's outcome 5: «Открытые вопросы должны закрываться, если агент в процессе нашел ответ».
    // The graph holds one open question about the first folder; the agent reads the bytes that answer it and writes the
    // answer as a fact of the schema, cited to the place it read. The question is closed by it — `inferred` and
    // proposed, because it is the agent's reading (0005) — and its evidence is the span the unit read.
    const ids = fixture();
    const question = makeNodeFact({
      kind: 'question',
      value: { repository: REPOSITORY, type: 'undocumented-behaviour', about: ids.files[0]!.id, prompt: 'why does the first folder hold one file?' },
      provenance: provenance('a/one.ts', 1),
      layer: 'inferred',
    });
    const opened = await openWorld({
      extraFacts: [question],
      script: {
        byPrompt: [],
        steps: [
          { say: 'reading the scope' },
          { call: { tool: 'assert_fact', arguments: {
            kind: 'answer',
            value: { repository: REPOSITORY, subject: question.id, decision: 'answers', text: 'one.ts is the only entry point the folder has', evidence: `${REPOSITORY}@${COMMIT}:a/one.ts` },
            place: { repository: REPOSITORY, file: 'a/one.ts', startLine: 1, endLine: 2 },
          } } },
          // The unit read the whole scope, so it publishes its set: a unit that leaves places uncovered splits into
          // children, and what this test holds is the answer it wrote, not its coverage.
          { answer: { status: 'done', covered: ['a', 'b', 'c'], remaining: [], summary: 'the first folder holds one file, and it is the way in' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      expect(worked.unitId).toBe(unit.unitId);

      // The answer is the unit's own fact: the schema's `answer` kind, at the agent's inferred layer, proposed until a
      // person accepts it (0005), and cited to the bytes the unit read.
      const published = (await readUnitFacts(opened.owner, unit.unitId)).map((entry) => entry.fact);
      const answer = published.find((fact) => fact.kind === 'answer') as unknown as { value: { repository: string; subject: string; decision: string; text: string; evidence: string }; layer: string; status: string } | undefined;
      expect(answer).toBeDefined();
      expect(answer!.value).toEqual({ repository: REPOSITORY, subject: question.id, decision: 'answers', text: 'one.ts is the only entry point the folder has', evidence: `${REPOSITORY}@${COMMIT}:a/one.ts` });
      expect(answer!.layer).toBe('inferred');
      expect(answer!.status).toBe('proposed');

      // And the question's page is closed by it: a reader of the wiki sees the answer, who found it and what it read.
      const page = await readPageModel({ database: opened.owner, product: PRODUCT, id: question.id });
      expect(page.ok).toBe(true);
      if (page.ok === false) throw new Error(page.message);
      const shown = page.page.answer;
      expect(shown?.decision).toBe('answers');
      expect(shown?.text).toBe('one.ts is the only entry point the folder has');
      expect(shown?.layer).toBe('inferred');
      expect(shown?.evidence).toBe(`${REPOSITORY}@${COMMIT}:a/one.ts`);
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

      // 0026's hard stop: the unit stopped at its context window, and the turn in flight was cancelled. The stop is
      // read from the run's own progress, because the agent's record cannot be: the connection closes right behind
      // the cancel, so reading that record would race the SIGTERM. The protocol's cancel, with the order it is sent
      // in, is asserted where it can be waited for (`test/fill-acp.test.ts`, "a turn the caller bounds").
      const stopLines = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its context window'));
      expect(stopLines.length).toBe(1);
      expect(stopLines[0]).toContain('220000 of 272000 tokens');
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
        const childFacts = (await readUnitFacts(opened.owner, child.unitId)).map((entry) => entry.fact);
        expect(childFacts.map((entry) => entry.kind)).toEqual(['coverage']);
      }
      // The children published and are fresh, so the waiting parent joins and is runnable again (0027's join).
      const swept = await sweepUnits(opened.orchestrator, { runId: RUN });
      expect(swept.refused).toEqual([]);
      expect(swept.swept.map((entry) => [entry.unitId, entry.outcome])).toEqual([[unit.unitId, 'join-enqueued']]);
      expect((await readRunUnits(opened.owner, RUN)).find((record) => record.unitId === unit.unitId)?.state).toBe('ready');

      // The parent's next attempt runs with the same agent, which stops at its limit again and names the same two
      // children: sealing a set this generation already sealed and published would re-run published work and, for a
      // unit that stops every time, never end. The split is refused with the children named, and the parent waits.
      await schedulerPass(opened.orchestrator, { runId: RUN });
      const again = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(again.result).toBe('blocked');
      expect(String(again.summary)).toContain('already sealed');
      expect(String(again.summary)).toContain(`${AGENT_UNIT_STAGE_ID}/${secondFolder!.id}`);
      expect(String(again.summary)).toContain(`${AGENT_UNIT_STAGE_ID}/${thirdFolder!.id}`);
      expect((await readRunUnits(opened.owner, RUN)).find((record) => record.unitId === unit.unitId)?.state).toBe('blocked');
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

  test('a turn in flight that never ends is stopped at 0026\'s ten minutes by the watch, and the unit keeps its coverage', async () => {
    // The finding this change answers (madarch-tzte.38): `session.prompt` is awaited and the limits are judged at
    // turn boundaries, so a turn that sends no update and never answers was bounded by no clock the guard could
    // see. The clock is the seam's and the timers are the test's: ten minutes pass without waiting.
    let at = NOW;
    const timers = instantTimers();
    const opened = await openWorld({
      // The agent takes the turn and sends nothing at all — no message, no usage, no answer.
      script: { byPrompt: [], steps: [{ wait: true }] },
      // Every read of the clock is two and a half minutes later than the one before, so the unit's ten minutes pass
      // within the turn's own wait and no test sleeps.
      clock: () => { at += 150_000; return at; },
      timers: timers.timers,
      // A clock that jumps two and a half minutes at a time would lapse the orchestrator's own lease: this test
      // holds the lease still so the limit it measures is the unit's, not the sweep's.
      limits: { leaseMs: 86_400_000 },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      // The attempt ends rather than staying inside the await: the unit returns what it has, with its coverage.
      expect(worked.result).toBe('split');
      // The turn in flight was armed on a watch of the guard's own clock, and the watch's cause is the guard's:
      // 0026's ten minutes. Two things are proven elsewhere: the time the watch arms for is asserted in
      // `test/fill-unit-limits.test.ts`, and the protocol's cancel of a turn that never ends — with the order it is
      // sent in — in `test/fill-acp.test.ts`. Here the attempt itself ends rather than staying inside the await,
      // which is this finding's own point, so nothing is read from the agent's record: the connection closes right
      // behind the cancel and that read would race the kill.
      expect(timers.waits.length).toBeGreaterThan(0);
      const stopped = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its time limit'));
      expect(stopped.length).toBe(1);
      expect(stopped[0]).toContain('of 600 seconds');
      // Nothing was read, so every place of the scope is a `budget` gap and a child unit's own scope: a silent turn
      // costs the unit its work and never the graph's account of what nobody read.
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const coverage = draft?.writes.at(-1)?.value as { kind: string; value: { complete: boolean; read: string[]; unread: { what: string; reason: string }[] } };
      expect(coverage.kind).toBe('coverage');
      expect(coverage.value.complete).toBe(false);
      expect(coverage.value.read).toEqual([]);
      expect(coverage.value.unread).toEqual([{ what: 'a', reason: 'budget' }, { what: 'b', reason: 'budget' }, { what: 'c', reason: 'budget' }]);
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unit.unitId);
      expect(children.length).toBe(3);
      expect(children.every((record) => record.state === 'planned')).toBe(true);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('an answer that names a place among its remaining covers it no longer, and the place becomes a child', async () => {
    // The unit contract's own words: a `done` answer whose `remaining` is not empty is read as `partial`. The
    // coverage counts `a` and `b` and leaves `c` as a budget gap, and the gap is a child unit's own scope.
    const opened = await openWorld({
      script: {
        byPrompt: [],
        steps: [
          { say: 'reading a and b' },
          { answer: { status: 'done', covered: ['a', 'b', 'c'], remaining: ['c'], summary: 'b is done, c is not' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('split');
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const coverage = draft?.writes[0]?.value as { kind: string; value: { complete: boolean; read: string[]; unread: { what: string; reason: string }[] } };
      expect(coverage.value.complete).toBe(false);
      expect(coverage.value.read).toEqual(['a', 'b']);
      expect(coverage.value.unread).toEqual([{ what: 'c', reason: 'budget' }]);
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unit.unitId);
      expect(children.map((record) => record.unitId)).toEqual([`${AGENT_UNIT_STAGE_ID}/${opened.graph.folders[2]!.id}`]);
    } finally {
      await opened.close();
    }
  }, 120_000);

  test('a parent whose children settled — one failed, under the run\'s accept-partial policy — does not seal them again', async () => {
    // 0027's third failed-child policy: a failed child is accepted, the parent joins, and the run carries on. A
    // parent that then names the same children again would re-run settled work for ever, so the same refusal
    // covers it: the comparison is against what this generation sealed, never against what published.
    const ids = fixture();
    const [, secondFolder, thirdFolder] = ids.folders;
    const opened = await openWorld({
      script: {
        byPrompt: [
          { matches: ids.repository.id, steps: [
            { say: 'reading the scope' },
            // The unit establishes one place of its scope before it is stopped: `a` is covered, and `b` and `c`
            // are the children it splits into.
            { call: { tool: 'raise_question', arguments: { type: 'assumption-check', prompt: 'Which folder owns the total?', place: { repository: REPOSITORY, file: 'a/one.ts', startLine: 1, endLine: 1 } } } },
            { usage: { used: 220_000, size: 272_000 } },
            { wait: true },
          ] },
          // The first child's agent dies mid-turn, and with no retry left that child fails for good.
          { matches: secondFolder!.id, steps: [{ say: 'reading' }, { exit: 1 }] },
          { matches: thirdFolder!.id, steps: [
            { say: 'reading the child scope' },
            { answer: { status: 'done', covered: ['c/one.ts'], remaining: [], summary: 'the child folder was read' } },
          ] },
        ],
        steps: [],
      },
      limits: { failedChildPolicy: 'accept-partial', retries: 0, leaseMs: 86_400_000 },
    });
    try {
      const unit = await planAndAdmit(opened);
      expect((await workOnce(opened.orchestrator, { worker: 'w1' })).result).toBe('split');
      // The children settle: one failed (its agent died and no retry is left), one published. The pass is driven by
      // the units' own states, and the assertion names the unit that moved if one moves the wrong way.
      const settledChildren = async (): Promise<readonly { unitId: string; state: string }[]> =>
        (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unit.unitId && (record.state === 'published' || record.state === 'failed'));
      for (let pass = 0; pass < 4 && (await settledChildren()).length < 2; pass += 1) {
        await schedulerPass(opened.orchestrator, { runId: RUN });
        const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
        // A child that splits here is a child whose script never matched its place: the failure names the unit so a
        // reader knows which child moved the wrong way.
        expect(worked.claimed ? `${worked.unitId}:${String(worked.result)}` : 'no job').toMatch(/:(failed|published|nothing-to-do)$|^no job$/u);
      }
      expect((await settledChildren()).map((record) => record.state).sort()).toEqual(['failed', 'published']);
      // `accept-partial` lets the parent join despite the failed child, so it is runnable again.
      const swept = await sweepUnits(opened.orchestrator, { runId: RUN });
      expect(swept.swept.map((entry) => [entry.unitId, entry.outcome])).toEqual([[unit.unitId, 'join-enqueued']]);
      // And its next attempt, naming the same two children, is refused rather than sealed again.
      await schedulerPass(opened.orchestrator, { runId: RUN });
      const again = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(again.result).toBe('blocked');
      expect(String(again.summary)).toContain('already sealed');
      expect((await readRunUnits(opened.owner, RUN)).find((record) => record.unitId === unit.unitId)?.state).toBe('blocked');
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a unit whose member list was cut does not publish the scope as read whole', async () => {
    // 150 folders in the repository: the member list the plan and the packet are given is cut by the graph read's
    // own 8K-token cap, so no unit was ever shown the whole scope. The agent covers every place it was shown, and
    // 0026 and 0005 make a complete coverage the only ground for a claim of absence: the coverage must say what it
    // could not enumerate rather than claim a scope nobody read.
    const folders = Array.from({ length: 150 }, (_unused, index) => `f${String(index).padStart(3, '0')}`);
    const opened = await openWorld({
      script: { byPrompt: [], steps: [{ say: 'reading what I was shown' }, { answerMembers: { summary: 'every place the packet listed was read' } }] },
      wide: folders,
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      const published = (await readUnitFacts(opened.owner, unit.unitId)).map((entry) => entry.fact);
      expect(published.length).toBe(1);
      const coverage = published[0] as unknown as { kind: string; value: { complete: boolean; read: string[]; unread: { what: string; reason: string }[] } };
      expect(coverage.kind).toBe('coverage');
      expect(coverage.value.complete).toBe(false);
      expect(coverage.value.read.length).toBeGreaterThan(0);
      expect(coverage.value.read.length).toBeLessThan(150);
      expect(coverage.value.unread.length).toBe(1);
      expect(coverage.value.unread[0]?.reason).toBe('budget');
      expect(coverage.value.unread[0]?.what).toContain('its member list did not hold');
    } finally {
      await opened.close();
    }
  }, 180_000);
});


describe('registering the agent stages of a run', () => {
  test('a run that wires an agent registers its agent stages; a run that wires none holds no unit that could read nothing', () => {
    const snapshots = createGitSnapshotSource(() => []);
    // A run with no agent: 0026's agent units are a session with an agent, so a stage registered without one would
    // plan units that could not run. Since madarch-tzte.24.1 the registry holds the fill's own agent stages (stage 8
    // today); the generic agent unit of 22.3 is the shape's reference declaration and is no stage of a run, because
    // it would read the same scopes a second time.
    expect(createStageRegistry({ snapshots }).all().map((stage) => stage.id)).not.toContain(OVERVIEW_STAGE_ID);
    expect(createStageRegistry({ snapshots }).all().map((stage) => stage.id)).not.toContain(AGENT_UNIT_STAGE_ID);
    const wired = createStageRegistry({ snapshots, agent: { agent: { id: 'fake-agent', command: 'bun' } } });
    expect(wired.get(OVERVIEW_STAGE_ID)?.usesTools).toBe(true);
    expect(wired.get(AGENT_UNIT_STAGE_ID)).toBeUndefined();
    // Stage 8 writes the overview hypothesis as claims and questions, the answer that closes a question the unit found
    // the evidence for (madarch-tzte.25.2), and the coverage the shape adds to every agent stage; each kind carries the
    // schema's own version.
    expect(wired.get(OVERVIEW_STAGE_ID)?.produces.map((produced) => produced.kind)).toEqual(['answer', 'claim', 'coverage', 'question']);
    expect(wired.get(OVERVIEW_STAGE_ID)?.produces.every((produced) => produced.schemaVersion === FACT_KINDS[produced.kind as 'claim'].version)).toBe(true);
  });
});

describe('the plan of the agent unit stage', () => {
  /**
   * The reads a plan makes, answered from a fixture that stands for the graph,
   * through the grammar's own read texts: the repositories by their form, what a
   * scope holds, the edges that place its members, and the members' own facts
   * (`neighbors` reads those to name what answered). A fixture whose member list is
   * longer than the answer's 8K-token cap is cut by `neighbors` itself, which is
   * what a real graph does.
   */
  function planReader(data: {
    readonly repositories: readonly { readonly id: string; readonly name: string; readonly form: string }[];
    readonly held: Readonly<Record<string, number>>;
    readonly members: Readonly<Record<string, readonly { readonly id: string; readonly path: string }[]>>;
  }): StageGraphReader {
    const all = new Map<string, { readonly id: string; readonly path: string }>();
    for (const members of Object.values(data.members)) for (const member of members) all.set(member.id, member);
    return {
      async query(text: string) {
        const request = JSON.parse(text) as { read: string; field?: string; value?: string; id?: string; ids?: readonly string[] };
        if (request.read === 'facts-with') {
          return data.repositories
            .filter((repository) => request.field === 'form' && repository.form === request.value)
            .map((repository) => ({
              id: repository.id,
              kind: 'repository',
              schema_version: 1,
              provenance: { source: { system: 'fixture', version: '1' }, repository: { id: repository.name, commit: 'a'.repeat(40) } },
              layer: 'extracted',
              status: 'proposed',
              value: { repository: repository.name, form: repository.form },
            }))
            .sort((left, right) => (left.id < right.id ? -1 : 1));
        }
        if (request.read === 'held') {
          const count = data.held[String(request.id)];
          return count === undefined ? [] : [{ kind: 'directory', count }];
        }
        if (request.read === 'adjacent') {
          return (data.members[String(request.id)] ?? []).map((member) => ({
            id: factId('contains', `${String(request.id)}->${member.id}`),
            kind: 'contains',
            schema_version: 1,
            provenance: { source: { system: 'fixture', version: '1' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) } },
            layer: 'extracted',
            status: 'proposed',
            value: { from: String(request.id), to: member.id },
          }));
        }
        if (request.read === 'facts') {
          return (request.ids ?? []).flatMap((id) => {
            const member = all.get(id);
            if (member === undefined) return [];
            return [{
              id,
              kind: 'directory',
              schema_version: 1,
              provenance: { source: { system: 'fixture', version: '1' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) } },
              layer: 'extracted',
              status: 'proposed',
              value: { repository: 'acme-shop', path: member.path },
            }];
          });
        }
        throw new Error(`the plan made a read this fixture does not answer: ${text}`);
      },
    };
  }

  /** A fact id of the schema's own form, from a seed the fixture names: the kind, a colon, and 64 lower-case hex. */
  function factId(kind: string, seed: string): string {
    return `${kind}:${createHash('sha256').update(seed).digest('hex')}`;
  }

  /** One repository holding `places` folders, which is what its `held` count and its members say. */
  function repository(name: string, places: number): { repository: { id: string; name: string; form: string }; held: Record<string, number>; members: Record<string, { id: string; path: string }[]> } {
    const id = factId('repository', name);
    const members = Array.from({ length: places }, (_unused, index) => ({ id: factId('directory', `${name}-${String(index).padStart(3, '0')}`), path: `f${String(index).padStart(3, '0')}` }));
    return { repository: { id, name, form: 'code' }, held: { [id]: places }, members: { [id]: members } };
  }

  test('a scope that fits 0026\'s planned size is one unit; one past it is planned as its member places', async () => {
    const small = repository('small-shop', 3);
    const planned = await planUnits(planReader({ repositories: [small.repository], held: small.held, members: small.members }));
    // 3 members at 0026's ~2000 tokens a member is 6000, inside the 136000 a unit plans for: one unit, and the
    // scope is the repository's own place.
    expect(planned.units).toEqual([{ id: small.repository.id, scope: 'small-shop', estimatedTokens: 6_000 }]);
    expect(planned.coverage).toBe('planned');

    // 80 members estimate 160000, past the planned size: the repository is planned as its member places, each of
    // them a unit of its own, in code point order of their paths.
    const wide = repository('wide-shop', 80);
    const split = await planUnits(planReader({ repositories: [wide.repository], held: wide.held, members: wide.members }));
    expect(split.units.length).toBe(80);
    expect(split.units[0]?.scope).toBe('wide-shop:f000');
    expect(split.units.at(-1)?.scope).toBe('wide-shop:f079');
    expect(split.units.every((unit) => unit.estimatedTokens === 0)).toBe(true);
  });

  test('a scope whose members are no places of their own is named as one unit, never by nothing', async () => {
    // A file's members are its symbols: `placeMembers` answers no place for such a scope, and enumerating nothing
    // would leave the file named by no unit at all. It stands as one unit, which splits at run time.
    const file = { id: factId('file', 'src/order.ts'), name: 'acme-shop', form: 'code' };
    const symbols = Array.from({ length: 70 }, (_unused, index) => ({ id: factId('symbol', `symbol-${String(index)}`), path: `src/order.ts#symbol${String(index)}` }));
    const reader: StageGraphReader = {
      async query(text: string) {
        const request = JSON.parse(text) as { read: string; field?: string; value?: string; id?: string; ids?: readonly string[] };
        if (request.read === 'facts-with') {
          // The repository is the file's parent in this fixture: the plan reads it once and answers one child.
          return [{ id: factId('repository', 'acme-shop'), kind: 'repository', schema_version: 1, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) } }, layer: 'extracted', status: 'proposed', value: { repository: 'acme-shop', form: 'code' } }];
        }
        if (request.read === 'held') {
          // The repository holds the file and defines its 70 symbols: 71 members, past 0026's planned size, so the
          // plan enumerates the repository and then the file.
          return request.id === factId('repository', 'acme-shop')
            ? [{ kind: 'file', count: 1 }, { kind: 'symbol', count: symbols.length }]
            : [{ kind: 'symbol', count: symbols.length }];
        }
        if (request.read === 'adjacent') {
          const from = String(request.id);
          if (from !== factId('repository', 'acme-shop')) return [];
          const provenance = { source: { system: 'fixture', version: '1' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) } };
          return [
            { id: factId('contains', 'repo->file'), kind: 'contains', schema_version: 1, provenance, layer: 'extracted', status: 'proposed', value: { from, to: file.id } },
            ...symbols.map((symbol) => ({ id: factId('defines', `repo->${symbol.id}`), kind: 'defines', schema_version: 1, provenance, layer: 'extracted', status: 'proposed', value: { from, to: symbol.id } })),
          ];
        }
        if (request.read === 'facts') {
          return (request.ids ?? []).flatMap((id) => id === file.id ? [{ id, kind: 'file', schema_version: 2, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) } }, layer: 'extracted', status: 'proposed', value: { repository: 'acme-shop', path: 'src/order.ts' } }] : []);
        }
        throw new Error(`the plan made a read this fixture does not answer: ${text}`);
      },
    };
    const planned = await planUnits(reader);
    // The repository holds one file whose estimate (70 × 2000) is past the planned size, so the plan enumerates the
    // repository; the file has no place members, so it stands as one unit — and the plan names it.
    expect(planned.units).toEqual([{ id: file.id, scope: 'acme-shop:src/order.ts', estimatedTokens: 140_000 }]);
    void symbols;
    void file.name;
    void file.form;
  });

  test('a plan past its bound collapses a scope to itself rather than dropping it', async () => {
    // Four repositories of 80 places each would be 320 units, past the plan's own bound. The scopes past it stand as
    // one unit each — the run's split bounds take them from there, and their coverage names what they did not read —
    // where a shorter list would leave places no unit ever names (0026: nothing silently smaller).
    const shops = ['aa', 'bb', 'cc', 'dd'].map((name) => repository(`${name}-shop`, 80));
    const planned = await planUnits(planReader({
      repositories: shops.map((shop) => shop.repository),
      held: Object.assign({}, ...shops.map((shop) => shop.held)),
      members: Object.assign({}, ...shops.map((shop) => shop.members)),
    }));
    // Every repository is named by at least one unit: the first three by 80 places each, the fourth by itself.
    const named = new Set(planned.units.map((unit) => unit.scope.split(':')[0]));
    expect([...named].sort()).toEqual(['aa-shop', 'bb-shop', 'cc-shop', 'dd-shop']);
    expect(planned.units.filter((unit) => unit.id === factId('repository', 'dd-shop')).map((unit) => unit.scope)).toEqual(['dd-shop']);
    expect(planned.units.length).toBeLessThanOrEqual(MAX_PLAN_UNITS + shops.length);
  });
});

describe('the unit contract, read', () => {
  test('the answer is the last object of the contract in a turn, and a turn without one is no answer', () => {
    // The agent is asked for one JSON object and nothing else; an agent that wraps it in prose is read by the
    // object's own shape, and the last such object of the turn is the answer.
    expect(readUnitAnswer('{"status":"done","covered":["a"],"remaining":[],"summary":"one"}')).toEqual({ status: 'done', covered: ['a'], remaining: [], summary: 'one' });
    expect(readUnitAnswer('Here it is: {"status":"partial","covered":["a","b"],"remaining":["c"]} — done.')).toEqual({ status: 'partial', covered: ['a', 'b'], remaining: ['c'] });
    expect(readUnitAnswer('{"status":"done","covered":["a"]}\n{"status":"partial","covered":[],"remaining":["a"]}')).toMatchObject({ status: 'partial', remaining: ['a'] });
    // No object, an object of another shape, and an object cut in half are no answer: the unit is asked again.
    expect(readUnitAnswer('still reading the scope')).toBeUndefined();
    expect(readUnitAnswer('{"covered":["a"],"remaining":[]}')).toBeUndefined();
    expect(readUnitAnswer('{"status":"done","covered":["a"')).toBeUndefined();
    expect(readUnitAnswer('')).toBeUndefined();
    // The lists are read as text entries only: a number or a nested object in them is no place.
    expect(readUnitAnswer('{"status":"done","covered":["a",3,{"b":1}],"remaining":[]}')).toEqual({ status: 'done', covered: ['a'], remaining: [] });
  });

  /** One place of the repository's scope, as the shape's place reader hands it to the coverage and the split. */
  function placeOf(path: string): AgentPlace {
    return { id: `directory:${path}`, place: path, scope: `acme-shop:${path}`, repository: 'acme-shop', commit: 'a'.repeat(40), estimatedTokens: MEMBER_ESTIMATE_TOKENS };
  }

  test('a place counts as covered only inside the scope, and the answer\'s own `remaining` is a refusal to claim it', () => {
    const places = ['a', 'b', 'c'].map(placeOf);
    const cite = (file: string): StageDraftWrite => ({ kind: 'fact', evidence: `acme-shop@${'a'.repeat(40)}:${file}`, value: { kind: 'question', value: { repository: 'acme-shop', type: 'assumption-check', prompt: 'why?' }, provenance: { source: { system: 'test', version: '1' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) }, place: { file, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } } } } });
    // A write inside a place covers that place; a write outside every place covers none; a path named with the
    // repository's prefix is read as its own path.
    expect(coveredOf({ answer: undefined, writes: [cite('a/one.ts')], places })).toEqual(['a']);
    expect(coveredOf({ answer: { covered: ['acme-shop:b', 'elsewhere/x.ts'], remaining: [] }, writes: [], places })).toEqual(['b']);
    // The contract's own words: a `done` answer whose `remaining` is not empty is read as `partial`.
    expect(coveredOf({ answer: { covered: ['a', 'b', 'c'], remaining: ['c'] }, writes: [], places })).toEqual(['a', 'b']);
    // A place nothing names, and a write that cites nothing, are no cover.
    expect(coveredOf({ answer: undefined, writes: [{ kind: 'fact', evidence: 'x', value: { kind: 'coverage' } }], places })).toEqual([]);
  });

  test('a split names one child per uncovered place, at most eight, and a scope is never its own child', () => {
    const places = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(placeOf);
    const eight = childrenOfPlaces({ scope: writeScope('acme-shop'), places, covered: [] });
    expect(eight.map((child) => child.scope)).toEqual(['acme-shop:a', 'acme-shop:b', 'acme-shop:c', 'acme-shop:d', 'acme-shop:e', 'acme-shop:f', 'acme-shop:g', 'acme-shop:h']);
    expect(eight.map((child) => child.id)).toEqual(['directory:a', 'directory:b', 'directory:c', 'directory:d', 'directory:e', 'directory:f', 'directory:g', 'directory:h']);
    // Each child is about one member's work, in 0026's own estimate.
    expect(eight.every((child) => child.estimatedTokens === MEMBER_ESTIMATE_TOKENS)).toBe(true);
    // The places nothing covered are the children; a place a unit covered is no child of it.
    expect(childrenOfPlaces({ scope: writeScope('acme-shop'), places, covered: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }).map((child) => child.scope)).toEqual(['acme-shop:j']);
    // A file's members stand at the file itself: such a place is no child of the scope it names.
    expect(childrenOfPlaces({ scope: writeScope('acme-shop:src/order.ts'), places: [{ ...placeOf('src/order.ts'), id: 'symbol:total' }], covered: [] })).toEqual([]);
  });

  test('the places a packet\'s member list holds are its folders and files, each once, in code point order', () => {
    const members = [
      { kind: 'file' as const, label: 'acme-shop:src/b.ts', id: 'file:b', file: 'src/b.ts', place: 'acme-shop:src/b.ts' },
      { kind: 'file' as const, label: 'acme-shop:src/a.ts', id: 'file:a', file: 'src/a.ts', place: 'acme-shop:src/a.ts' },
      { kind: 'entry-point' as const, label: 'serve', id: 'entry-point:serve', file: 'src/a.ts', place: 'acme-shop:src/a.ts' },
      { kind: 'module' as const, label: 'checkout', id: 'module:checkout' },
    ];
    const packet = {
      unit: { id: 'acme-shop:src', scope: 'acme-shop:src' },
      place: { repository: 'acme-shop', path: 'src', commit: 'a'.repeat(40) },
      members,
      membersCut: false,
    } as unknown as UnitPacket;
    const places = memberPlaces({ unit: { id: 'acme-shop:src', scope: 'acme-shop:src' }, scope: writeScope('acme-shop:src'), packet, graph: { async query() { return []; } } });
    // The member that stands at a path names it: the entry point at `src/a.ts` does not take the file's place.
    expect(places.places.map((place) => [place.place, place.id, place.scope])).toEqual([
      ['src/a.ts', 'file:a', 'acme-shop:src/a.ts'],
      ['src/b.ts', 'file:b', 'acme-shop:src/b.ts'],
    ]);
    expect(places.cut).toBe(false);
    // A member list a read cut is no enumeration of the scope: the places say so, and the coverage names the gap.
    expect(memberPlaces({ unit: { id: 'acme-shop', scope: 'acme-shop' }, scope: writeScope('acme-shop'), packet: { ...packet, membersCut: true } as unknown as UnitPacket, graph: { async query() { return []; } } }).cut).toBe(true);
  });
});
