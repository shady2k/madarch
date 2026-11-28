/**
 * One pressed fill's end is the answer the press waits on (ALX-2023, `madarch-47vw.7`). On the ALX-1717 stand a fill
 * failed and the wiki kept answering 409 until the daemon restarted: a run whose plan refused, or whose `fill-runs` job's
 * retries were spent, stood for ever with no end, so the press hung and every later press waited behind it.
 *
 * These cases drive the real path: one live `KnowledgeProduct.startFill` through the store's own `fill-runs` queue, the
 * fill role that claims it, and the run's end read back from the store. Every fill is deterministic and runs no model.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { readPinnedGraphContract } from '../src/product/preparation-contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { readFillEnd, writeFillEndIfAbsent } from '../src/graph/fill-orchestration.js';
import { advanceRun, createRun, readChain, readRun, readRunUnits } from '../src/graph/fill-state.js';
import { listRepositories } from '../src/graph/records.js';
import type { FillStateDatabase } from '../src/graph/fill-state.js';
import { claimFillRun, FILL_RUN_QUEUE, openFillRunQueue } from '../src/fill/run-jobs.js';
import { createOrchestrator, DEFAULT_ORCHESTRATOR_LIMITS, failAndSettleRun, planRun } from '../src/fill/orchestrator.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createStagesFill } from '../src/product/fill-stages.js';
import { runFillRole } from '../src/knowledge/fill-role.js';
import { gitEnv } from './git-env.js';
import { makeProduct, SAMPLE_IDENTITY, withRepositoryPluginsOnly } from './knowledge-fixture.js';

const work = mkdtempSync(join(tmpdir(), 'madarch-fill-recovery-'));
const opened: { close?(): Promise<void>; stop?(): Promise<void> }[] = [];
const products: KnowledgeProduct[] = [];

afterAll(async () => {
  for (const product of products.splice(0)) await product.close().catch(() => undefined);
  while (opened.length > 0) {
    const one = opened.pop()!;
    await one.stop?.().catch(() => undefined);
    await one.close?.().catch(() => undefined);
  }
  rmSync(work, { recursive: true, force: true });
});

/** One product over a real repository, with only the deterministic repository plugins declared. */
function fixture(label: string): { folder: string; knowledgeRoot: string; home: string; name: string } {
  const env = gitEnv(SAMPLE_IDENTITY);
  const repository = join(work, `repo-${label}`);
  mkdirSync(join(repository, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository, env });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const price = 10;\n');
  execFileSync('git', ['add', '-A'], { cwd: repository, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'one'], { cwd: repository, env });
  const home = join(work, `home-${label}`);
  mkdirSync(home, { recursive: true });
  const folder = makeProduct(home, label, repository, 'shop-code');
  withRepositoryPluginsOnly(folder);
  return { folder, knowledgeRoot: knowledgeRootOf(home), home, name: label };
}

/**
 * The product's own fill role, run until the caller says it is done: the role claims the product's `fill-runs` job, runs the
 * fill the press asked for, and answers the end the api waits on. It is the same loop `madarch serve` drives as a child, and
 * it keeps running across presses, so a case that presses twice needs no role restart either.
 */
async function driveRole(place: { folder: string; knowledgeRoot: string }, done: () => boolean, log: (line: string) => void = () => undefined): Promise<number> {
  const graphContract = withAssertionContract(await readPinnedGraphContract(place.folder));
  return await runFillRole({
    knowledgeRoot: place.knowledgeRoot,
    log,
    idle: done,
    openStore: async (folder) => Object.assign(await createDatabaseOwner({ store: folder, connectOnly: true }), { graphContract }),
  });
}

/** The store's graph database, prepared the way the server prepares it before a fill is pressed. */
async function preparedStore(place: { folder: string; knowledgeRoot: string }): Promise<{ owner: Awaited<ReturnType<typeof createDatabaseOwner>>; database: FillStateDatabase; storeFolder: string }> {
  const storeFolder = productStoreFolder(place.folder, place.knowledgeRoot);
  const graphContract = withAssertionContract(await readPinnedGraphContract(place.folder));
  await requestStorePreparation(join(storeFolder, 'graph'), graphContract);
  const owner = await createDatabaseOwner({ store: join(storeFolder, 'graph'), connectOnly: true });
  opened.push(owner);
  return { owner, database: { transaction: owner.transaction.bind(owner), graphContract }, storeFolder };
}

test('a job whose attempts are spent ends the pressed run instead of leaving the press waiting', async () => await withStorePreparationOwner(async () => {
  const place = fixture('spent');
  const { owner } = await preparedStore(place);
  const pressed = new KnowledgeProduct({ productFolder: place.folder, storeRoot: place.knowledgeRoot, fillQueued: true });
  products.push(pressed);
  const queued = await openFillRunQueue(owner);
  opened.push(queued);
  const started = await pressed.startFill({ pluginsOnly: true });
  if (!started.started) throw new Error(`the press was refused before the queue: ${started.message}`);
  // No fill role runs: this store's press keeps its job until its attempts are spent, which is what a killed role
  // leaves behind.
  const shift = async (where: string): Promise<void> => {
    await owner.transaction('write', async (tx) => { await tx.query(`UPDATE pgboss.job SET start_after = clock_timestamp() WHERE ${where}`, []); });
  };
  let settled = false;
  for (let attempt = 0; attempt < 3 && !settled; attempt += 1) {
    let claimed = await claimFillRun(queued);
    for (let tries = 0; tries < 60 && claimed === null; tries += 1) {
      await shift("name = 'fill-runs' AND state = 'retry'");
      await Bun.sleep(50);
      claimed = await claimFillRun(queued);
    }
    if (claimed === null) break;
    if (await queued.fail(FILL_RUN_QUEUE, claimed, 'the fixture attempt ended without settling') === 'failed') settled = true;
    else await shift(`id = '${claimed.id}'::uuid`);
  }
  expect(settled).toBe(true);
  // The press's own poll sees the job has no attempt left and ends its request: the page answers, the graph reads.
  await pressed.settled();
  const end = await readFillEnd(owner, started.runId);
  expect(end?.state).toBe('failed');
  expect((await pressed.status()).fill.state).toBe('failed');
}), 120_000);

test('a planning refusal ends the press, leaves the graph readable, and the same product fills again without a restart', async () => await withStorePreparationOwner(async () => {
  const place = fixture('refusal');
  const { owner, database, storeFolder } = await preparedStore(place);
  const graphFolder = join(storeFolder, 'graph');

  // The seed: a run the product's chain does not follow — nothing started it on the chain, nothing ended it — whose units
  // the product's own plugins planned and left standing. It is what a run the fill role gave up on looks like: its units
  // are `planned` and its owner has not ended, so another run that plans them meets a unit another run works.
  const seedRun = 'seeded-run';
  const seeded = await createStagesFill({
    product: place.folder, database: owner, runId: seedRun, store: place.home,
    prepareContract: async (contract) => { await requestStorePreparation(graphFolder, contract); },
  });
  const unitQueue = await createPgBossQueue({ owner, supervise: false });
  opened.push(unitQueue);
  await unitQueue.declare({ name: 'fill-units', leaseSeconds: DEFAULT_ORCHESTRATOR_LIMITS.attemptSeconds, heartbeatSeconds: DEFAULT_ORCHESTRATOR_LIMITS.heartbeatSeconds, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const orchestrator = createOrchestrator({
    database: { transaction: owner.transaction.bind(owner), graphContract: seeded.wiring.graphContract },
    registry: seeded.registry, queue: unitQueue, queueName: 'fill-units', product: seeded.product.name,
    configuration: async () => await seeded.wiring.configuration(), snapshot: () => seeded.wiring.snapshot(),
    graph: (ref, tx) => seeded.wiring.graph(ref, tx), inputs: (ref) => seeded.wiring.inputs(ref), operations: seeded.wiring.operations,
  });
  await createRun(database, { runId: seedRun, product: place.name, at: Date.now() });
  const plannedSeed = await planRun(orchestrator, { runId: seedRun });
  if (plannedSeed.outcome !== 'planned') throw new Error(`the fixture seed did not plan: ${JSON.stringify(plannedSeed)}`);
  expect(plannedSeed.units.length).toBeGreaterThan(0);

  // One live product, the real fill role and the product's own queues: the press is one no test replaces.
  const press = new KnowledgeProduct({ productFolder: place.folder, storeRoot: place.knowledgeRoot, fillQueued: true });
  products.push(press);
  let roleDone = false;
  const roleLog: string[] = [];
  const role = driveRole(place, () => roleDone, (line) => { roleLog.push(line); if (roleLog.length > 40) roleLog.shift(); });
  try {
    const started = await press.startFill({ pluginsOnly: true });
    if (!started.started) throw new Error(`the press was refused before the queue: ${started.message}`);

    // The run meets the seed's unit while it plans, and the refusal reaches a terminal result instead of standing for ever.
    let end = await readFillEnd(owner, started.runId);
    for (let waited = 0; end === null && waited < 120; waited += 1) {
      await Bun.sleep(1_000);
      end = await readFillEnd(owner, started.runId);
    }
    if (end === null) throw new Error(`the refused press got no end; the fill role says: ${roleLog.slice(-4).join(' | ')}`);
    expect(end?.state).toBe('failed');
    expect(end?.message ?? '').toContain('unit-in-another-run');
    expect((await readRun(database, started.runId))?.state).toBe('failed');
    // What the failed run held is released: nothing stands active for the next run to take.
    expect((await readChain(owner, place.name))?.state).toBe('quiescent');
    // The graph reads while nothing runs: the page the press answers is the store's own state.
    expect((await press.status()).fill.state).toBe('failed');

    // The seed ends the way a run that will not finish ends, and the same product is asked for again: no daemon restart,
    // the same role and the same live product, a new job.
    await failAndSettleRun({ database, product: place.name, clock: Date.now }, { runId: seedRun, detail: 'the fixture seed ended' });
    const again = await press.startFill({ pluginsOnly: true });
    if (!again.started) throw new Error(`the product refused a fresh fill after its run failed: ${again.message}`);
    await press.settled();
    const endAgain = await readFillEnd(owner, again.runId);
    expect(endAgain?.state).toBe('succeeded');
    // The completed run's result is its own: a run the fixture ended does not mask the fill that succeeded after it.
    expect(endAgain?.message).toBeUndefined();
    expect((await readRun(database, again.runId))?.state).toBe('succeeded');
    // The graph the press now reads holds what the run published: its units are published and the repository facts are
    // read from the store, not from a run row.
    const published = (await readRunUnits(database, again.runId)).filter((unit) => unit.state === 'published');
    expect(published.length).toBeGreaterThan(0);
    const repositories = await listRepositories(owner);
    expect(repositories.map((repository) => repository.name)).toContain('shop-code');
    const statusAgain = await press.status();
    expect(statusAgain.fill.state).toBe('done');
    expect(statusAgain.fill.runPhase).toBe('succeeded');
  } finally {
    roleDone = true;
    await press.settled().catch(() => undefined);
    await role.catch(() => undefined);
  }
}), 240_000);

test('a press that loses the run transition leaves the run\'s own completion its end', async () => await withStorePreparationOwner(async () => {
  const place = fixture('loser');
  const { owner, database } = await preparedStore(place);
  const press = new KnowledgeProduct({ productFolder: place.folder, storeRoot: place.knowledgeRoot, fillQueued: true });
  products.push(press);
  const queued = await openFillRunQueue(owner);
  opened.push(queued);
  const started = await press.startFill({ pluginsOnly: true });
  if (!started.started) throw new Error(`the press was refused before the queue: ${started.message}`);
  // No fill role runs: the run reaches `succeeded` through its own machine, as a normal completion does, and only then
  // writes its end after finishing the store. The press's poll sees a spent job while that end is not written yet.
  await advanceRun(database, { runId: started.runId, event: { type: 'plan', at: Date.now(), configuration: 'fixture' } });
  await advanceRun(database, { runId: started.runId, event: { type: 'start', at: Date.now(), stages: 1 } });
  const completed = await advanceRun(database, { runId: started.runId, event: { type: 'complete', at: Date.now(), evidence: { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true } } });
  if (!completed.ok) throw new Error(`the fixture run did not complete: ${completed.refusal.reason}`);
  // The job's attempts are spent, which is what a killed role leaves behind: the press's poll takes its fallback path.
  const shift = async (where: string): Promise<void> => {
    await owner.transaction('write', async (tx) => { await tx.query(`UPDATE pgboss.job SET start_after = clock_timestamp() WHERE ${where}`, []); });
  };
  let spent = false;
  for (let attempt = 0; attempt < 3 && !spent; attempt += 1) {
    let claimed = await claimFillRun(queued);
    for (let tries = 0; tries < 60 && claimed === null; tries += 1) {
      await shift("name = 'fill-runs' AND state = 'retry'");
      await Bun.sleep(50);
      claimed = await claimFillRun(queued);
    }
    if (claimed === null) break;
    if (await queued.fail(FILL_RUN_QUEUE, claimed, 'the fixture attempt ended without settling') === 'failed') spent = true;
    else await shift(`id = '${claimed.id}'::uuid`);
  }
  expect(spent).toBe(true);
  // The fallback found the run already succeeded, so it publishes nothing and keeps waiting: a fallback failure never
  // overwrites a result the run won (ALX-2024, ALX-2026 finding 4).
  await Bun.sleep(6_000);
  expect(await readFillEnd(owner, started.runId)).toBeNull();
  // The completion's own end lands, and it is the answer the press reads.
  expect(await writeFillEndIfAbsent(database, { runId: started.runId, state: 'succeeded' })).toBe(true);
  await press.settled();
  expect((await readFillEnd(owner, started.runId))?.state).toBe('succeeded');
  expect((await readRun(database, started.runId))?.state).toBe('succeeded');
  const status = await press.status();
  expect(status.fill.state).toBe('done');
  expect(status.fill.runPhase).toBe('succeeded');
  // A second end, from either side, never replaces it.
  expect(await writeFillEndIfAbsent(database, { runId: started.runId, state: 'failed', message: 'late fallback' })).toBe(false);
  expect((await readFillEnd(owner, started.runId))?.state).toBe('succeeded');
}), 120_000);
