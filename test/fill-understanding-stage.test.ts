/**
 * Stage 12, the modules understood bottom-up, end to end on the agent-stage shape
 * (decision 0026, stage 12; madarch-tzte.24.5).
 *
 * A fixture graph of three module levels — a root, two of its children, and two
 * leaves under one of them — is published into the fill's own fact store, and the
 * stage runs under the real orchestrator with the fake ACP agent of
 * `test/fixtures/acp-fake-agent` (no real prompt, no network, no token spent): the
 * plan names the leaves first, a parent whose module has children splits into them
 * before it reads anything and stands down at `waiting_children`, the run joins it
 * when the children have published, and only the joined attempt reads the children's
 * summaries and writes the module's own. Every expectation is taken from the task
 * and the decisions: the plan order 0026's hierarchy gives, the bounds its "Scale"
 * fixes, and 0027's split, join and staleness semantics.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFactGraphReader } from '../src/fill/graph-reads.js';
import { draftSetOf } from '../src/fill/checked-writes.js';
import { createFillOrchestratorService, type ProductFillWiring } from '../src/fill/orchestrator-host.js';
import { createOrchestrator, planRun, schedulerPass, startRun, workOnce, type FillOrchestrator } from '../src/fill/orchestrator.js';
import { createOrchestratorSchema, readProgress, type RunSnapshot } from '../src/fill/orchestrator-store.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import {
  UNDERSTANDING_KINDS,
  UNDERSTANDING_STAGE_ID,
  UNDERSTANDING_SUMMARY_PREDICATE,
  createUnderstandingStage,
  moduleUnits,
  understandingDeclaration,
} from '../src/fill/stages/understanding.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { FACT_KINDS } from '../src/fill/facts.js';
import { Type } from 'typebox';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readTransitions } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { QueueService } from '../src/fill/queue.js';
import { graphReadsOver } from '../src/fill/graph-reads.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-2026-10-20T08:00Z';
const REPOSITORY = 'orders-api';
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let root: string | undefined;
let COMMITS: Readonly<Record<string, string>> = {};

function provenance(file: string, line: number): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: REPOSITORY, commit: COMMITS[REPOSITORY] ?? 'a'.repeat(40) },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/** A module fact of the fixture tree, at its own file's bytes. */
function moduleFact(name: string, parent: string | undefined, file: string, members: number, importance: number): Fact {
  return makeNodeFact({
    kind: 'module',
    value: { repository: REPOSITORY, name, ...(parent === undefined ? {} : { parent }), seed: 'cluster', members, importance },
    provenance: provenance(file, 1),
    layer: 'extracted',
  });
}

/** A file fact of the fixture tree. */
function fileFact(path: string, lines: number): Fact {
  return makeNodeFact({ kind: 'file', value: { repository: REPOSITORY, path: repositoryPath(path), roles: ['source'] }, provenance: provenance(path, 1), layer: 'extracted' });
}

/** The fixture tree of three levels: shop holds checkout and payments, and checkout holds cart and total. */
interface Tree {
  readonly shop: Fact;
  readonly checkout: Fact;
  readonly payments: Fact;
  readonly cart: Fact;
  readonly total: Fact;
  facts(): readonly Fact[];
}

function fixture(): Tree {
  const files = new Map<string, Fact>([
    ['src/shop.ts', fileFact('src/shop.ts', 4)],
    ['src/order.ts', fileFact('src/order.ts', 4)],
    ['src/payments.ts', fileFact('src/payments.ts', 4)],
    ['src/cart.ts', fileFact('src/cart.ts', 4)],
    ['src/total.ts', fileFact('src/total.ts', 4)],
  ]);
  const shop = moduleFact('shop', undefined, 'src/shop.ts', 5, 0.9);
  const checkout = moduleFact('checkout', shop.id, 'src/order.ts', 3, 0.6);
  const payments = moduleFact('payments', shop.id, 'src/payments.ts', 2, 0.5);
  const cart = moduleFact('cart', checkout.id, 'src/cart.ts', 1, 0.3);
  const total = moduleFact('total', checkout.id, 'src/total.ts', 1, 0.2);
  const contains = (from: Fact, to: Fact): Fact => makeEdgeFact({ kind: 'contains', value: { from: from.id, to: to.id }, provenance: provenance('src/shop.ts', 1), layer: 'extracted' });
  const repository = makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('src/shop.ts', 1), layer: 'extracted' });
  return {
    shop, checkout, payments, cart, total,
    facts: () => [
      repository,
      ...files.values(),
      shop, checkout, payments, cart, total,
      contains(shop, files.get('src/shop.ts')!),
      contains(checkout, files.get('src/order.ts')!),
      contains(payments, files.get('src/payments.ts')!),
      contains(cart, files.get('src/cart.ts')!),
      contains(total, files.get('src/total.ts')!),
    ],
  };
}

/** Publishes facts into the fill's own fact store, as a run's earlier stage would have. */
async function seedFacts(owner: DatabaseOwner, facts: readonly Fact[]): Promise<void> {
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  await createUnit(owner, { unitId: 'graph/all', product: PRODUCT, runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const seed = await owner.transaction('snapshot', async (executor) => (await executor.query<{ unit_id: string; generation: number }>('SELECT unit_id, generation FROM fill_unit WHERE unit_id = $1', ['graph/all'])).rows[0]);
  if (seed === undefined) throw new Error('the fixture unit was not created');
  const record = { unitId: 'graph/all', generation: Number(seed.generation) } as Parameters<typeof applyPublishedFacts>[0]['unit'];
  await owner.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: record,
    plan: { unitId: 'graph/all', generation: record.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: `graph-publication-${String(facts.length)}`,
    writes: facts.map((fact) => ({ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMITS[REPOSITORY] ?? ''}`, value: fact })),
  }));
}

/** The stand-in for the deterministic stages: it declares what the tree stage publishes, and plans no unit. */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'module', 'file', 'contains'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'module'].version, scope: 'repository' as const })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: () => ({ units: [] }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
  };
}

/** One world: a database with the fill's tables and the fixture tree, the orchestrator, the tool host and a fake agent's script. */
interface World {
  readonly owner: DatabaseOwner;
  readonly orchestrator: FillOrchestrator;
  readonly server: StartedServer;
  readonly record: string;
  readonly matches: readonly string[];
  sent(): readonly Record<string, unknown>[];
  close(): Promise<void>;
}

/** What one world is opened with: the fake agent's script, the graph it reads, and the orchestrator's own limits where a test holds them still. */
interface WorldOptions {
  readonly script: { readonly byPrompt: readonly { readonly matches: string; readonly steps: readonly unknown[] }[]; readonly steps: readonly unknown[] };
  readonly facts?: () => readonly Fact[];
  readonly limits?: Parameters<typeof createOrchestrator>[0]['limits'];
}

async function openWorld(options: WorldOptions): Promise<World> {
  const folder = mkdtempSync(join(root!, 'world-'));
  const scriptPath = join(folder, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(options.script));
  const record = join(folder, 'agent-record.jsonl');

  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', leaseSeconds: 3_600, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });

  const tree = options.facts === undefined ? fixture() : { facts: options.facts };
  await createUnit(owner, { unitId: 'graph/all', product: PRODUCT, runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const seed = await owner.transaction('snapshot', async (executor) => (await executor.query<{ unit_id: string; generation: number }>('SELECT unit_id, generation FROM fill_unit WHERE unit_id = $1', ['graph/all'])).rows[0]);
  if (seed === undefined) throw new Error('the fixture unit was not created');
  const record0 = { unitId: 'graph/all', generation: Number(seed.generation) } as Parameters<typeof applyPublishedFacts>[0]['unit'];
  await owner.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: record0,
    plan: { unitId: 'graph/all', generation: record0.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: 'graph-publication-1',
    writes: tree.facts().map((fact) => ({ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMITS[REPOSITORY] ?? ''}`, value: fact })),
  }));

  const pins: readonly RepositoryPin[] = [
    { id: REPOSITORY, form: 'code', root: join(root!, REPOSITORY), commit: COMMITS[REPOSITORY]! },
  ];
  const snapshots = createGitSnapshotSource(() => pins);
  const snapshot: RunSnapshot = { repository: 'example.invalid/acme/orders', defaultBranch: 'main', commit: COMMITS[REPOSITORY]!, registryHash: 'sha256:registry' };
  const wiring: ProductFillWiring = {
    snapshot: () => snapshot,
    configuration: () => undefined,
    graph: () => createFactGraphReader({ database: owner, snapshot: snapshots }),
    inputs: () => ({}),
    source: () => snapshots,
  };
  const registry = new StageRegistry()
    .register(structureStage())
    .register(createUnderstandingStage({
      snapshots,
      agent: { id: 'fake-agent', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', scriptPath, '--record', record] },
      clock: () => NOW,
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
  server = await startServer({ productHome: home, appFolder, port: 0, orchestrator: service, log: () => undefined, errorLog: () => undefined });

  const orchestrator = createOrchestrator({
    database: owner,
    registry,
    queue,
    queueName: 'fill-units',
    product: PRODUCT,
    configuration: () => undefined,
    snapshot: () => snapshot,
    graph: async (ref, transaction) => createFactGraphReader({ database: owner, snapshot: snapshots, ...(transaction === undefined ? {} : { executor: transaction }) }),
    inputs: () => ({}),
    facts: (await import('../src/fill/fact-store.js')).FACT_APPLICATION,
    clock: () => NOW,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    unitTools: async (opening) => await service.unitTools({
      product: { name: PRODUCT, folder: home },
      unit: { unitId: opening.unit.unitId, generation: opening.unit.generation },
      url: `${server!.url}${UNIT_TOOL_PATH}`,
      draft: draftSetOf(opening.draft),
    }),
  });

  return {
    owner,
    orchestrator,
    server,
    record,
    matches: (options.script.byPrompt ?? []).map((entry) => entry.matches ?? ''),
    sent: () => readFileSync(record, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>),
    close: async () => {
      await server!.stop();
      await service.stop();
      await queue.stop().catch(() => undefined);
      await owner.close();
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-understanding-stage-'));
  const commits: Record<string, string> = {};
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const make = (repository: string, files: Readonly<Record<string, string>>): string => {
    const folder = join(root!, repository);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), body);
    }
    git(folder, 'init', '-q');
    git(folder, 'config', 'user.name', 'Fixture');
    git(folder, 'config', 'user.email', 'fixture@example.invalid');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-qm', 'one');
    return git(folder, 'rev-parse', 'HEAD').trim();
  };
  commits[REPOSITORY] = make(REPOSITORY, {
    'src/shop.ts': 'export function shop() {\n  return "the ordering shop";\n}\n',
    'src/order.ts': 'export function placeOrder(cart) {\n  return { total: cart.total, state: "placed" };\n}\n',
    'src/payments.ts': 'export function charge(card) {\n  return { charged: card.amount };\n}\n',
    'src/cart.ts': 'export function addItem(cart, item) {\n  return [...cart, item];\n}\n',
    'src/total.ts': 'export function total(cart) {\n  return cart.reduce((sum, item) => sum + item.price, 0);\n}\n',
  });
  COMMITS = commits;
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The prompt texts the fake agent was sent, in order. */
function prompts(opened: World): readonly string[] {
  return opened.sent()
    .filter((message) => message['method'] === 'session/prompt')
    .map((message) => String(((message['params'] as { prompt?: { text?: string }[] }).prompt ?? [])[0]?.text ?? ''));
}

/** The facts one unit published, as the store holds them. */
async function publishedFacts(opened: World, unitId: string): Promise<readonly Fact[]> {
  const { readUnitFacts } = await import('../src/fill/fact-store.js');
  return (await readUnitFacts(opened.owner, unitId)).map((entry) => entry.fact);
}

/** One claim the fake agent asserts through `assert_fact`, cited to the module's own file. */
function claimCall(moduleId: string, predicate: string, text: string, file: string): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'claim',
        value: { subject: { form: 'node', id: moduleId }, predicate, object: { form: 'literal', text }, text, confidence: 0.6 },
        place: { repository: REPOSITORY, file, startLine: 1, endLine: 1 },
      },
    },
  };
}

/** One business rule the fake agent asserts, with the span of the lines that carry it. */
function ruleCall(moduleId: string, statement: string, file: string): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'rule',
        value: { statement, form: 'invariant', subject: moduleId },
        place: { repository: REPOSITORY, file, startLine: 1, endLine: 2 },
      },
    },
  };
}

/** A `done` answer naming the one file the module holds. */
function doneAnswer(file: string, summary: string): unknown {
  return { answer: { status: 'done', covered: [file], remaining: [], summary } };
}

/** Drives the run with one worker until everything has settled or the rounds run out. */
async function drive(opened: World, rounds = 40): Promise<readonly string[]> {
  const results: string[] = [];
  for (let at = 0; at < rounds; at += 1) {
    await schedulerPass(opened.orchestrator, { runId: RUN });
    const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
    if (!worked.claimed || worked.result === undefined) continue;
    results.push(`${worked.unitId}:${worked.result}`);
  }
  await explainIfUnpublished(opened);
  return results;
}

/** When the drive left a unit short of `published`, says what the run recorded, so a failure names its own sequence. */
async function explainIfUnpublished(opened: World): Promise<void> {
  const { readRunUnits } = await import('../src/fill/state-store.js');
  const units = await readRunUnits(opened.owner, RUN);
  const short = units.filter((unit) => unit.state !== 'published');
  if (short.length === 0) return;
  const events = await readProgress(opened.owner, RUN);
  console.log(`[stage-12 fixture] units short of published: ${short.map((unit) => `${unit.unitId}:${unit.state}`).join(', ')}`);
  for (const event of events) console.log(`[stage-12 fixture] ${event.stage}/${event.unitId} ${event.kind}: ${event.summary}`);
  const prompts = opened.sent().filter((message) => message['method'] === 'session/prompt').map((message) => String(((message['params'] as { prompt?: { text?: string }[] }).prompt ?? [])[0]?.text ?? ''));
  for (const prompt of prompts) {
    const matched = opened.matches.find((candidate) => candidate !== '' && prompt.includes(candidate));
    console.log(`[stage-12 fixture] prompt (${String(prompt.length)} chars) runs ${matched === undefined ? 'the default steps' : `the steps of ${JSON.stringify(matched)}`}; its unit section: ${prompt.slice(prompt.indexOf('"unit"'), prompt.indexOf('"unit"') + 120).replace(/\n/g, ' ')}`);
  }
}

describe('stage 12, the modules understood bottom-up', () => {
  test('a tree of three levels: the leaves publish first, a parent waits for its children and reads their summaries, and every module gets its summary, responsibilities, role and rules', async () => {
    const tree = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [
          { matches: `"id": "${tree.cart.id}"`, steps: [
            claimCall(tree.cart.id, UNDERSTANDING_SUMMARY_PREDICATE, 'cart holds the shopping cart and its items', 'src/cart.ts'),
            claimCall(tree.cart.id, 'responsible-for', 'cart keeps the items the shopper picked', 'src/cart.ts'),
            claimCall(tree.cart.id, 'serves-as', 'the shopping cart of the ordering shop', 'src/cart.ts'),
            ruleCall(tree.cart.id, 'an item is added to the cart only with a price', 'src/cart.ts'),
            doneAnswer('src/cart.ts', 'cart holds the shopping cart'),
          ] },
          { matches: `"id": "${tree.total.id}"`, steps: [
            claimCall(tree.total.id, UNDERSTANDING_SUMMARY_PREDICATE, 'total sums the prices of the cart', 'src/total.ts'),
            doneAnswer('src/total.ts', 'total sums the cart'),
          ] },
          { matches: `"id": "${tree.payments.id}"`, steps: [
            claimCall(tree.payments.id, UNDERSTANDING_SUMMARY_PREDICATE, 'payments charges the card for the order', 'src/payments.ts'),
            doneAnswer('src/payments.ts', 'payments charges the card'),
          ] },
          { matches: `"id": "${tree.checkout.id}"`, steps: [
            claimCall(tree.checkout.id, UNDERSTANDING_SUMMARY_PREDICATE, 'checkout takes the cart, totals it and hands the order on', 'src/order.ts'),
            doneAnswer('src/order.ts', 'checkout takes the cart and hands the order on'),
          ] },
          { matches: `"id": "${tree.shop.id}"`, steps: [
            claimCall(tree.shop.id, UNDERSTANDING_SUMMARY_PREDICATE, 'shop is the ordering shop: checkout takes an order and payments charges it', 'src/shop.ts'),
            doneAnswer('src/shop.ts', 'shop is the ordering shop'),
          ] },
        ],
        steps: [{ answerMembers: { summary: 'the module was read' } }],
      },
      limits: { leaseMs: 86_400_000 },
    });
    try {
      const started = await startRun(opened.orchestrator, { runId: RUN });
      expect(started.ok).toBe(true);
      const planned = await planRun(opened.orchestrator, { runId: RUN });
      if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
      // The tree's own order, deepest first: the two leaves under checkout, then checkout and payments, then the root.
      expect(planned.units.map((unit) => unit.stageUnitId)).toEqual([tree.cart.id, tree.total.id, tree.checkout.id, tree.payments.id, tree.shop.id]);
      // A unit's scope is its repository, where its members' bytes stand.
      expect(planned.units.map((unit) => unit.scope)).toEqual([REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY]);

      const results = await drive(opened);
      // The parent modules split before they read anything, and publish on the attempt that follows their join.
      expect(results.filter((line) => line.startsWith(`${UNDERSTANDING_STAGE_ID}/${tree.checkout.id}:`))).toEqual([
        `${UNDERSTANDING_STAGE_ID}/${tree.checkout.id}:split`,
        `${UNDERSTANDING_STAGE_ID}/${tree.checkout.id}:published`,
      ]);
      expect(results.filter((line) => line.startsWith(`${UNDERSTANDING_STAGE_ID}/${tree.shop.id}:`))).toEqual([
        `${UNDERSTANDING_STAGE_ID}/${tree.shop.id}:split`,
        `${UNDERSTANDING_STAGE_ID}/${tree.shop.id}:published`,
      ]);
      // The 0027 dependency, on the mid module's own record: it stood down at waiting_children and was joined.
      const midJournal = (await readTransitions(opened.owner, { kind: 'unit', id: `${UNDERSTANDING_STAGE_ID}/${tree.checkout.id}` })).map((entry) => entry.transitionId);
      expect(midJournal).toContain('unit/running--wait-for-children-->waiting_children');
      expect(midJournal).toContain('unit/waiting_children--join-all-published-->ready');

      // Five prompts: three leaves, and one joined attempt each for checkout and shop. A parent is never
      // prompted before its children have published — the split happened before any session was opened.
      const sent = prompts(opened);
      expect(sent.length).toBe(5);
      const packetOf = (prompt: string): Record<string, unknown> => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>;
      const packets = sent.map(packetOf);
      // Each leaf's packet holds the shape's own sections and its (empty) children's summaries, named by the
      // section's `when`: a leaf is a unit of the module level too, and its graph read answers no children.
      const cartPacket = packets.find((packet) => (packet['scope'] as { id?: string } | undefined)?.id === tree.cart.id)!;
      expect(Object.keys(cartPacket)).toEqual(['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'childrenSummaries', 'writes', 'marker']);
      expect(cartPacket['childrenSummaries']).toEqual([]);
      // The joined mid module's packet holds its children's bounded summaries, one row per child in code point
      // order of their fact ids: what the children published, and what the parent builds on.
      const midPacket = packets.find((packet) => (packet['scope'] as { id?: string } | undefined)?.id === tree.checkout.id)!;
      const midRows = [...(midPacket['childrenSummaries'] as readonly { module: string; name: string; summary: string | null }[])]
        .sort((left: { module: string }, right: { module: string }) => (left.module < right.module ? -1 : 1));
      expect(midRows).toEqual([
        { module: tree.cart.id, name: 'cart', summary: 'cart holds the shopping cart and its items' },
        { module: tree.total.id, name: 'total', summary: 'total sums the prices of the cart' },
      ]);
      // The root's packet holds its children's summaries — checkout's among them, which only exists because
      // checkout published before the root's joined attempt was built.
      const rootPacket = packets.find((packet) => (packet['scope'] as { id?: string } | undefined)?.id === tree.shop.id)!;
      const rootRows = [...(rootPacket['childrenSummaries'] as readonly { module: string; summary: string | null }[])]
        .map((row: { module: string; summary: string | null }) => [row.module, row.summary] as const)
        .sort((left, right) => (left[0]! < right[0]! ? -1 : 1));
      expect(rootRows).toEqual([
        [tree.checkout.id, 'checkout takes the cart, totals it and hands the order on'],
        [tree.payments.id, 'payments charges the card for the order'],
      ]);

      // What a leaf published: its summary, its responsibilities, its role, its rule with the span that
      // carries it, and the coverage of its reading.
      const cartFacts = await publishedFacts(opened, `${UNDERSTANDING_STAGE_ID}/${tree.cart.id}`);
      expect(cartFacts.map((fact) => fact.kind).sort()).toEqual(['claim', 'claim', 'claim', 'coverage', 'rule']);
      const cartClaims = cartFacts.filter((fact) => fact.kind === 'claim');
      expect(cartClaims.map((claim) => (claim.value as { predicate: string }).predicate).sort()).toEqual(['responsible-for', 'serves-as', UNDERSTANDING_SUMMARY_PREDICATE].sort());
      const cartRule = cartFacts.find((fact) => fact.kind === 'rule')!;
      expect((cartRule.value as { statement: string }).statement).toBe('an item is added to the cart only with a price');
      expect(cartRule.layer).toBe('inferred');
      expect(cartRule.status).toBe('proposed');
      expect(String(cartRule.provenance.place?.file)).toBe('src/cart.ts');
      // The coverage names the module by its fact id (the schema's own scope for a module) and what of it was read.
      const cartCoverage = cartFacts.find((fact) => fact.kind === 'coverage')!;
      const cartCoverageValue = cartCoverage.value as unknown as { repository: string; scope: string; complete: boolean; read: readonly string[] };
      expect(cartCoverageValue).toMatchObject({ repository: REPOSITORY, scope: tree.cart.id, complete: true, read: ['src/cart.ts'] });
      // Every unit of the run published.
      const { readRunUnits } = await import('../src/fill/state-store.js');
      const units = await readRunUnits(opened.owner, RUN);
      expect(units.filter((unit) => unit.state !== 'published').map((unit) => `${unit.unitId}:${unit.state}`)).toEqual([]);
    } finally {
      await opened.close();
    }
  }, 240_000);

  test('a parent of more children than one split may seal rounds through the bound: it seals eight, joins, seals the rest, and reads every summary', async () => {
    // Nine leaves under one wide module: the first split seals eight, the join wakes the parent, the second
    // split seals the ninth, and only then does the parent read the nine summaries.
    const leaves = 9;
    const wide = moduleFact('wide', undefined, 'src/wide.ts', leaves + 1, 0.9);
    const children = Array.from({ length: leaves }, (_, at) => moduleFact(`leaf-${String(at)}`, wide.id, `src/leaf-${String(at)}.ts`, 1, 0.5));
    const fileOf = new Map<string, Fact>([
      ['src/wide.ts', fileFact('src/wide.ts', 3)],
      ...children.map((child, at) => [`src/leaf-${String(at)}.ts`, fileFact(`src/leaf-${String(at)}.ts`, 3)] as const),
    ]);
    const heldBy = new Map<string, Fact>([[wide.id, fileOf.get('src/wide.ts')!], ...children.map((child, at) => [child.id, fileOf.get(`src/leaf-${String(at)}.ts`)!] as const)]);
    const opened = await openWorld({
      facts: () => [
        makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('src/wide.ts', 1), layer: 'extracted' }),
        ...fileOf.values(),
        wide, ...children,
        ...[...heldBy].map(([from, file]) => makeEdgeFact({ kind: 'contains', value: { from, to: file.id }, provenance: provenance(String((file.value as { path: string }).path), 1), layer: 'extracted' })),
      ],
      script: {
        byPrompt: [{ matches: 'src/wide.ts', steps: [doneAnswer('src/wide.ts', 'the wide module was understood')] }],
        steps: [{ answerMembers: { summary: 'the leaf was read' } }],
      },
    });
    try {
      const started = await startRun(opened.orchestrator, { runId: RUN });
      expect(started.ok).toBe(true);
      const planned = await planRun(opened.orchestrator, { runId: RUN });
      if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
      expect(planned.units.length).toBe(leaves + 1);
      await drive(opened);
      const journal = (await readTransitions(opened.owner, { kind: 'unit', id: `${UNDERSTANDING_STAGE_ID}/${wide.id}` })).map((entry) => entry.transitionId);
      // Two rounds: the first split sealed the bound's eight, the second the one left over.
      expect(journal.filter((id) => id === 'unit/running--wait-for-children-->waiting_children').length).toBe(2);
      expect(journal.filter((id) => id.startsWith('unit/waiting_children--join-')).length).toBe(2);
      expect(journal.at(-1)).toBe('unit/validating--publish-->published');
      const { readRunUnits } = await import('../src/fill/state-store.js');
      const units = await readRunUnits(opened.owner, RUN);
      expect(units.filter((unit) => unit.state !== 'published').map((unit) => `${unit.unitId}:${unit.state}`)).toEqual([]);
    } finally {
      await opened.close();
    }
  }, 240_000);

  test('a child that fails under the run\'s accept-partial policy lets the parent join, and the parent publishes no complete coverage over a missing summary', async () => {
    // shop holds checkout, checkout holds cart; cart dies mid-session. The policy accepts the partial child:
    // checkout joins it, its packet holds the child's summary as `null`, and its own answer is `partial`.
    const tree = fixture();
    const files = new Map<string, Fact>([
      ['src/shop.ts', fileFact('src/shop.ts', 3)],
      ['src/order.ts', fileFact('src/order.ts', 3)],
      ['src/cart.ts', fileFact('src/cart.ts', 3)],
    ]);
    const held = new Map<string, Fact>([
      [tree.shop.id, files.get('src/shop.ts')!],
      [tree.checkout.id, files.get('src/order.ts')!],
      [tree.cart.id, files.get('src/cart.ts')!],
    ]);
    const opened = await openWorld({
      facts: () => [
        makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('src/shop.ts', 1), layer: 'extracted' }),
        tree.shop, tree.checkout, tree.cart,
        // Each module holds its own file; the tree itself rides on the modules' parent values.
        ...files.values(),
        ...[...held].map(([from, file]) => makeEdgeFact({ kind: 'contains', value: { from, to: file.id }, provenance: provenance(String((file.value as { path: string }).path), 1), layer: 'extracted' })),
      ],
      script: {
        byPrompt: [
          // cart's own prompt: the agent process ends without answering, and with no retry left the child fails.
          { matches: 'src/cart.ts', steps: [{ exit: 1 }] },
          // checkout's joined attempt: the section holds the failed child's summary as `null`.
          { matches: 'src/order.ts', steps: [{ answer: { status: 'partial', covered: ['src/order.ts'], remaining: [], summary: 'checkout is understood but its child cart did not finish' } }] },
          { matches: 'src/shop.ts', steps: [doneAnswer('src/shop.ts', 'shop is the ordering shop')] },
        ],
        steps: [{ answerMembers: { summary: 'the module was read' } }],
      },
      limits: { leaseMs: 86_400_000, retries: 0, failedChildPolicy: 'accept-partial' },
    });
    try {
      const started = await startRun(opened.orchestrator, { runId: RUN });
      expect(started.ok).toBe(true);
      const planned = await planRun(opened.orchestrator, { runId: RUN });
      if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
      expect(planned.units.map((unit) => unit.stageUnitId)).toEqual([tree.cart.id, tree.checkout.id, tree.shop.id]);
      await drive(opened);
      const { readRunUnits } = await import('../src/fill/state-store.js');
      const stateOf = new Map((await readRunUnits(opened.owner, RUN)).map((unit) => [unit.unitId, unit.state] as const));
      expect(stateOf.get(`${UNDERSTANDING_STAGE_ID}/${tree.cart.id}`)).toBe('failed');
      // The parent joined the failed child and published — with the child's summary absent, and its own
      // `partial` answer keeping the coverage from claiming a whole it did not read (0005).
      expect(stateOf.get(`${UNDERSTANDING_STAGE_ID}/${tree.checkout.id}`)).toBe('published');
      const checkoutFacts = await publishedFacts(opened, `${UNDERSTANDING_STAGE_ID}/${tree.checkout.id}`);
      const checkoutCoverage = checkoutFacts.find((fact) => fact.kind === 'coverage')!.value as unknown as { scope: string; complete: boolean; read: readonly string[] };
      expect(checkoutCoverage).toMatchObject({ scope: tree.checkout.id, complete: false, read: ['src/order.ts'] });
      // The failed child's row is the packet's own words for "did not finish": `null`, never an empty summary.
      // The row the failed child holds in its parent's section spells `"module": <the child's id>`; the child's
      // own prompt carries its id as the unit's, so the two are told apart by the row's own key.
      const checkoutPrompt = prompts(opened).find((prompt) => prompt.includes(`"module": "${tree.cart.id}"`))!;
      expect(checkoutPrompt).toContain('"childrenSummaries"');
      expect(checkoutPrompt).toContain('"summary": null');
      // The root built on checkout's published partial understanding.
      expect(stateOf.get(`${UNDERSTANDING_STAGE_ID}/${tree.shop.id}`)).toBe('published');
    } finally {
      await opened.close();
    }
  }, 240_000);
});

describe('stage 12\'s declaration', () => {
  test('the modules of 0026\'s cluster level, claims and rules at the meaning level, the children\'s summaries, and the bottom-up plan', async () => {
    const tree = fixture();
    const declaration = understandingDeclaration();
    expect(declaration.factStage).toBe('12-understanding');
    expect(declaration.level).toBe('meaning');
    // 0026's hierarchy: a module is a cluster, and the level below it is a place.
    expect(declaration.scale).toEqual({ level: 'cluster', child: 'place' });
    expect(declaration.kinds).toEqual(UNDERSTANDING_KINDS);
    expect(declaration.kinds).toEqual(['claim', 'rule']);
    // The schema's own table writes both kinds at this stage of the fill.
    expect(FACT_KINDS.claim.stages).toContain('12-understanding');
    expect(FACT_KINDS.rule.stages).toContain('12-understanding');
    // The section names are the packet's own, in the order the stage declares them.
    expect(declaration.sections?.map((section) => section.name)).toEqual(['childrenSummaries']);
    // The answer is the unit contract: how far the module was read, and what is left.
    expect(declaration.answer.fields.map((field) => field.name)).toEqual(['status', 'covered', 'remaining', 'summary']);
    // The registry holds no understanding stage where the run wires no agent: a stage whose units run an
    // agent is registered only with one (0026).
    expect(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }).get(UNDERSTANDING_STAGE_ID)).toBeUndefined();
  });

  test('the plan names the leaves first and refuses a module whose children stand past the fan-in bound', async () => {
    const owner = createPGliteDatabaseOwner();
    try {
      await createFactStoreSchema(owner);
      const pins: readonly RepositoryPin[] = [{ id: REPOSITORY, form: 'code', root: join(root!, REPOSITORY), commit: COMMITS[REPOSITORY]! }];
      const snapshots = createGitSnapshotSource(() => pins);
      const reader = createFactGraphReader({ database: owner, snapshot: snapshots });
      // The three-level tree: the plan's order is the tree's own, deepest first.
      const tree = fixture();
      await seedFacts(owner, tree.facts());
      const planned = await moduleUnits(reader);
      expect(planned.units.map((unit) => unit.id)).toEqual([tree.cart.id, tree.total.id, tree.checkout.id, tree.payments.id, tree.shop.id]);
      expect(planned.coverage).toBe('planned');
      // A wide module: fifty-two children stand past the fan-in bound of fifty, and the plan says which
      // module and which bound, naming the grouping that holds the rule. One owner, one seed: the bound's
      // refusal reads the same store the tree's own order was read from.
      const wideOwner = createPGliteDatabaseOwner();
      try {
        const wide = moduleFact('wide', undefined, 'src/wide.ts', 52, 0.9);
        const children = Array.from({ length: 52 }, (_, at) => moduleFact(`fan-${String(at)}`, wide.id, `src/fan-${String(at)}.ts`, 1, 0.1));
        await seedFacts(wideOwner, [
          makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('src/wide.ts', 1), layer: 'extracted' }),
          wide, ...children,
        ]);
        const wideReader = createFactGraphReader({ database: wideOwner, snapshot: snapshots });
        let message = '';
        try {
          await moduleUnits(wideReader);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain(`the module ${wide.id} (wide) of ${REPOSITORY} holds 52 child modules and the fan-in bound is 50`);
        expect(message).toContain('an intermediate grouping level');
      } finally {
        await wideOwner.close();
      }
    } finally {
      await owner.close();
    }
  });
});
