/**
 * One pressed fill's run job is the run's own lock, and the run's end is the answer the press waits on (ALX-2023,
 * `madarch-47vw.7`). Two things went wrong on the ALX-1717 stand: a job handed back to the queue read as "the process
 * that ran it ended", ending the run the retry was asking to drive; and a run whose plan refused — or whose job's
 * retries were spent — stood for ever with no end, so the press hung and every later press got 409 until the daemon
 * restarted.
 *
 * These cases drive the real path: one live `KnowledgeProduct.startFill` through the store's own `fill-runs` queue, the
 * fill role that claims it, and the run's end read back from the store. Every fill is deterministic and runs no model.
 */
import { afterAll, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { readPinnedGraphContract } from '../src/product/preparation-contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { startKnowledgeFill } from '../src/knowledge/fill-run.js';
import { runFill } from '../src/fill/run.js';
import { writeOrchestration, writeFillEndIfAbsent, readSealedChildren, sealSplitIn } from '../src/graph/fill-orchestration.js';
import { readFillEnd, readProgress } from '../src/graph/fill-orchestration.js';
import { advanceChainIn, advanceRun, advanceUnitIn, createRun, createUnitIn, openChainIn, readChain, readRun, readRunUnits, readUnit, readUnitGeneration, type UnitRecord } from '../src/graph/fill-state.js';
import { listRepositories } from '../src/graph/records.js';
import type { FillStateDatabase } from '../src/graph/fill-state.js';
import { claimFillRun, enqueueFillRun, FILL_RUN_QUEUE, fillRunHeldElsewhere, openFillRunQueue, settleFillRun } from '../src/fill/run-jobs.js';
import { admitUnits, createOrchestrator, DEFAULT_ORCHESTRATOR_LIMITS, failAndSettleRun, planRun, recoverOrphanedRun, schedulerPass, startRun, workOnce, type FillOrchestrator } from '../src/fill/orchestrator.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { StageRegistry } from '../src/fill/registry.js';
import { fixtureOperations } from './fill-operation-fixture.js';
import { createStagesFill } from '../src/product/fill-stages.js';
import { runFillRole } from '../src/knowledge/fill-role.js';
import type { OuterTransaction } from '../src/history-types.js';
import { gitEnv } from './git-env.js';
import { makeProduct, SAMPLE_IDENTITY, withRepositoryPluginsOnly } from './knowledge-fixture.js';

const work = mkdtempSync(join(tmpdir(), 'madarch-fill-recovery-'));
const opened: { close?(): Promise<void>; stop?(): Promise<void> }[] = [];
const products: KnowledgeProduct[] = [];

/**
 * The file's own cleanup. Every fixture here has a store of its own with its own PostgreSQL server, and closing one is a
 * shutdown checkpoint of that store — local work with nothing shared between two fixtures — so the closes run beside each
 * other instead of one after another. Done one by one they take longer than the 60 s a hook is given, and the file failed
 * after all fourteen of its cases had passed (measured 2026-11-28 on agent-linux-01, 2 vCPU: seven product closes at 14,
 * 9 359, 4, 99, 30 256, 5, 255 and 20 841 ms — 60.8 s — while every queue and owner of the file closed in 1.5 s together).
 * The bound is named because the work is long: the same closes beside each other end in about 30 s, the heaviest store's
 * own checkpoint, and a machine slower than this one keeps its own room instead of failing the file's teardown.
 */
afterAll(async () => {
  const closing: Promise<void>[] = products.splice(0).map(async (product) => { await product.close().catch(() => undefined); });
  for (const one of opened.splice(0)) {
    closing.push((async () => {
      await one.stop?.().catch(() => undefined);
      await one.close?.().catch(() => undefined);
    })());
  }
  await Promise.all(closing);
  rmSync(work, { recursive: true, force: true });
}, 180_000);

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

test('a retried claim carries its own run on instead of ending it', async () => await withStorePreparationOwner(async () => {
  const place = fixture('retry');
  const { owner, database, storeFolder } = await preparedStore(place);
  const queue = await openFillRunQueue(owner);
  opened.push(queue);
  const runId = 'retried-run';
  const job = { product: place.folder, store: storeFolder, runId };
  expect((await enqueueFillRun(queue, job)).created).toBe(true);
  // The first attempt dies before it plans: its claim is failed, the queue holds the retry.
  const first = await claimFillRun(queue);
  if (first === null) throw new Error('the fixture job was not claimed');
  expect(await queue.fail(FILL_RUN_QUEUE, first, 'the fixture attempt ended without settling')).toBe('retry');
  // The retry waits the queue's five seconds; the case moves its moment instead of sleeping through it.
  await owner.transaction('write', async (tx) => { await tx.query(`UPDATE pgboss.job SET start_after = clock_timestamp() WHERE id = $1::uuid`, [first.id]); });
  const second = await claimFillRun(queue);
  if (second === null) throw new Error('the fixture retry was not claimed');
  expect(second.attempt).toBe(1);
  // The fill closes the owner it is given, so the case reads the store through its own.
  const fillOwner = await createDatabaseOwner({ store: join(storeFolder, 'graph'), connectOnly: true });
  const fill = await startKnowledgeFill({
    productFolder: place.folder, storeFolder, runId, database: fillOwner,
    prepareContract: async (contract) => await requestStorePreparation(join(storeFolder, 'graph'), contract),
    claim: { queueService: queue, queue: FILL_RUN_QUEUE, job: second },
  });
  try {
    const answer = await fill.done;
    // The retried attempt carried the same run on. On the base it read its own retry as a dead process, ended the run
    // the retry named, and the attempt then refused with `fill-orchestrator/run-not-plannable`.
    expect(JSON.stringify(answer)).not.toContain('run-not-plannable');
    const events = await readProgress(database, runId).catch(() => []);
    expect(events.some((event) => event.summary.includes('the process that ran it ended'))).toBe(false);

  } finally {
    await fill.close().catch(() => undefined);
  }
}), 120_000);

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

test('a live claim keeps its long-running run from being recovered', async () => await withStorePreparationOwner(async () => {
  const place = fixture('live');
  const { owner, database, storeFolder } = await preparedStore(place);
  const queue = await openFillRunQueue(owner);
  opened.push(queue);
  // A run that published nothing for the recovery window, while its own fill-runs job is claimed and heartbeating: the
  // claim is the product's, whatever the run's own rows last said.
  const longRun = 'long-running';
  const old = Date.now() - 10 * 60_000;
  await createRun(database, { runId: longRun, product: place.name, at: old });
  await advanceRun(database, { runId: longRun, event: { type: 'plan', at: old + 1_000, configuration: 'fixture' } });
  await advanceRun(database, { runId: longRun, event: { type: 'start', at: old + 2_000, stages: 1 } });
  expect((await enqueueFillRun(queue, { product: place.folder, store: storeFolder, runId: longRun })).created).toBe(true);
  const held = await claimFillRun(queue);
  if (held === null) throw new Error('the fixture claim was not taken');
  // The chain follows the run the claim drives, the way the run's own start left it, and the claim is alive now.
  await writeOrchestration(database, async (tx) => {
    await openChainIn(tx, { product: place.name, at: old });
    await advanceChainIn(tx, { product: place.name, event: { type: 'start', at: old + 2_000, runId: longRun } });
  });
  await owner.transaction('write', async (tx) => {
    await tx.query(`UPDATE pgboss.job SET heartbeat_on = clock_timestamp(), started_on = clock_timestamp() WHERE id = $1::uuid`, [held.id]);
  });

  // A caller that holds no claim of its own asks for another run of the same product.
  const pressOwner = await createDatabaseOwner({ store: join(storeFolder, 'graph'), connectOnly: true });
  const other = await startKnowledgeFill({ productFolder: place.folder, storeFolder, runId: 'pressed-behind', database: pressOwner });
  const answer = await other.done;
  await other.close().catch(() => undefined);
  expect(answer.ok).toBe(false);
  // The live run is untouched: no end of its own, still the state it stood in.
  expect(await readFillEnd(owner, longRun)).toBeNull();
  expect((await readRun(database, longRun))?.state).toBe('running');
}), 120_000);

test('a direct call leaves a run the product\'s queue still holds, and takes the chain once that claim is spent', async () => await withStorePreparationOwner(async () => {
  const place = fixture('direct');
  const { owner, database, storeFolder } = await preparedStore(place);
  const queued = await openFillRunQueue(owner);
  opened.push(queued);
  const unitQueue = await createPgBossQueue({ owner, supervise: false });
  opened.push(unitQueue);
  await unitQueue.declare({ name: 'fill-units', leaseSeconds: 60, heartbeatSeconds: 30, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const orchestrator = createOrchestrator({
    database, registry: new StageRegistry(), product: place.name, queue: unitQueue, queueName: 'fill-units',
    configuration: async () => undefined,
    snapshot: async () => ({ repository: place.folder, defaultBranch: 'main', commit: 'a1b2c3d4', registryHash: 'sha256:fixture' }),
    graph: () => ({ query: async () => [] }), inputs: () => ({}), operations: fixtureOperations(owner),
  });
  // A run nothing moved for far longer than the recovery window, whose `fill-runs` job the queue still holds and whose units
  // are all done: the run's own rows say "nothing moved", the claim says a process was asked for it and still drives it. A
  // direct caller — `madarch fill`, the daemon's inline press — reaches this boundary with no claim of its own and never
  // passes the wrapper's earlier check, which is what let this path take the chain from a live run.
  const longRun = 'direct-long-run';
  const old = Date.now() - 10 * 60_000;
  await createRun(database, { runId: longRun, product: place.name, at: old });
  await advanceRun(database, { runId: longRun, event: { type: 'plan', at: old + 1_000, configuration: 'fixture' } });
  await advanceRun(database, { runId: longRun, event: { type: 'start', at: old + 2_000, stages: 1 } });
  await writeOrchestration(database, async (tx) => {
    await openChainIn(tx, { product: place.name, at: old });
    await advanceChainIn(tx, { product: place.name, event: { type: 'start', at: old + 2_000, runId: longRun } });
  });
  expect((await enqueueFillRun(queued, { product: place.folder, store: storeFolder, runId: longRun })).created).toBe(true);
  const held = await claimFillRun(queued);
  if (held === null) throw new Error('the fixture claim was not taken');
  await owner.transaction('write', async (tx) => {
    await tx.query(`UPDATE pgboss.job SET heartbeat_on = clock_timestamp(), started_on = clock_timestamp() WHERE id = $1::uuid`, [held.id]);
  });
  const heldByQueue = async (transaction?: Parameters<typeof fillRunHeldElsewhere>[2]) => await fillRunHeldElsewhere(owner, place.folder, transaction);
  // The direct call is refused at the chain, and the run the claim holds keeps its state and its missing end.
  const refused = await startRun(orchestrator, { runId: 'direct-new-run', heldByQueue });
  if (refused.ok) throw new Error(`a direct call took the chain from a run the product's queue still holds: ${JSON.stringify(refused)}`);
  expect(refused.code).toBe('fill-orchestrator/chain-active');
  expect(await readFillEnd(owner, longRun)).toBeNull();
  expect((await readRun(database, longRun))?.state).toBe('running');
  // The production direct entries — `madarch fill` and the daemon's inline press — reach the same boundary through
  // `runFill`, which drives a service with no claim of its own: it too is refused, and the live run keeps its state and
  // its missing end. This is the wiring, not a callback the case supplies.
  const cli = await runFill({
    product: place.folder, database: owner, runId: 'direct-cli-run', store: place.home, home: place.home,
    prepareContract: async (contract) => { await requestStorePreparation(join(storeFolder, 'graph'), contract); },
  });
  if (cli.ok) throw new Error(`the direct entry took the chain from a run the product's queue still holds: ${JSON.stringify(cli)}`);
  expect(cli.code).toBe('fill-orchestrator/chain-active');
  expect(await readFillEnd(owner, longRun)).toBeNull();
  expect((await readRun(database, longRun))?.state).toBe('running');
  // A queue this process cannot open or declare proves nothing either way: asked through the same helper the wiring
  // reaches, the answer is "not known", and the recovery boundary leaves the prior run where it stands.
  const unreadable = await createDatabaseOwner({ store: join(storeFolder, 'graph'), connectOnly: true });
  await unreadable.close();
  const unreadableQueue = async (transaction?: Parameters<typeof fillRunHeldElsewhere>[2]) => await fillRunHeldElsewhere(unreadable, place.folder, transaction);
  expect(await fillRunHeldElsewhere(unreadable, place.folder)).toBeNull();
  expect(await recoverOrphanedRun(orchestrator, { runId: longRun, at: Date.now(), heldByQueue: unreadableQueue })).toBeNull();
  const refusedUnreadable = await startRun(orchestrator, { runId: 'direct-unreadable-run', heldByQueue: unreadableQueue });
  if (refusedUnreadable.ok) throw new Error(`a queue that cannot be opened let a direct call end a live run: ${JSON.stringify(refusedUnreadable)}`);
  expect(refusedUnreadable.code).toBe('fill-orchestrator/chain-active');
  expect(await readFillEnd(owner, longRun)).toBeNull();
  expect((await readRun(database, longRun))?.state).toBe('running');
  // The claim is spent, attempt after attempt, and the queue holds nothing for the run any more: now nothing drives it, and
  // the same direct call ends it and takes the chain.
  expect(await queued.fail(FILL_RUN_QUEUE, held, 'the fixture attempt ended without settling')).toBe('retry');
  await owner.transaction('write', async (tx) => { await tx.query(`UPDATE pgboss.job SET start_after = clock_timestamp() WHERE id = $1::uuid`, [held.id]); });
  const retried = await claimFillRun(queued);
  if (retried === null) throw new Error('the fixture retry was not claimed');
  expect(await queued.fail(FILL_RUN_QUEUE, retried, 'the fixture retry ended without settling')).toBe('failed');
  expect(await fillRunHeldElsewhere(owner, place.folder)).toBe(false);
  const taken = await startRun(orchestrator, { runId: 'direct-new-run', heldByQueue });
  if (!taken.ok) throw new Error(`the direct call was refused after the claim was spent: ${taken.reason}`);
  expect((await readRun(database, longRun))?.state).toBe('failed');
  expect((await readFillEnd(owner, longRun))?.state).toBe('failed');
  expect((await readChain(owner, place.name))?.context.activeRunId).toBe('direct-new-run');
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

test('a live unit job keeps its run from being recovered, and the run is recovered once that job is spent', async () => await withStorePreparationOwner(async () => {
  const place = fixture('units');
  const { owner, database } = await preparedStore(place);
  const unitQueue = await createPgBossQueue({ owner, supervise: false });
  opened.push(unitQueue);
  const queueName = 'fill-units';
  await unitQueue.declare({ name: queueName, leaseSeconds: 60, heartbeatSeconds: 30, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const orchestrator = createOrchestrator({
    database, registry: new StageRegistry(), product: place.name, queue: unitQueue, queueName,
    configuration: async () => undefined,
    snapshot: async () => ({ repository: place.folder, defaultBranch: 'main', commit: 'a1b2c3d4', registryHash: 'sha256:fixture' }),
    graph: () => ({ query: async () => [] }), inputs: () => ({}), operations: fixtureOperations(owner),
  });
  // A run that has published nothing for far longer than the recovery window, whose one unit the queue still holds as a
  // claimed job: the run's own rows say "nothing moved", the queue's claim says a worker holds it. Only the second is the
  // proof that the run is being worked (ALX-2024, ALX-2026 finding 1).
  const longRun = 'long-unit-run';
  const unitId = 'plugin-turns/disk:code.repository';
  const old = Date.now() - 10 * 60_000;
  await createRun(database, { runId: longRun, product: place.name, at: old });
  await advanceRun(database, { runId: longRun, event: { type: 'plan', at: old + 1_000, configuration: 'fixture' } });
  await advanceRun(database, { runId: longRun, event: { type: 'start', at: old + 2_000, stages: 1 } });
  await writeOrchestration(database, async (tx) => {
    await createUnitIn(tx, { unitId, product: place.name, runId: longRun, stageId: 'disk', scopeKey: 'code.repository', inputsDigest: 'fixture', retries: 0, at: old });
    const admitted = await advanceUnitIn(tx, { unitId, event: { type: 'admit', at: old + 3_000, generation: 1 } });
    if (!admitted.ok) throw new Error(`the fixture unit was not admitted: ${admitted.refusal.reason}`);
  });
  await writeOrchestration(database, async (tx) => {
    await openChainIn(tx, { product: place.name, at: old });
    await advanceChainIn(tx, { product: place.name, event: { type: 'start', at: old + 2_000, runId: longRun } });
  });
  const enqueued = await unitQueue.enqueue({ queue: queueName, data: { unitId, generation: 1 }, singletonKey: unitId });
  const [held] = await unitQueue.claim<{ unitId: string; generation: number }>({ queue: queueName });
  if (held === undefined || held.id !== enqueued.id) throw new Error('the fixture unit job was not claimed');

  // The unit's own row is old, but the job is claimed and heartbeating now: recovery leaves the run alone.
  expect(await recoverOrphanedRun(orchestrator, { runId: longRun, at: Date.now() })).toBeNull();
  expect(await readFillEnd(owner, longRun)).toBeNull();
  expect((await readRun(database, longRun))?.state).toBe('running');

  // The same rows, once the job is spent and nothing holds the unit: now the run has stood still for the window, and it
  // is recovered — the claim, not the timestamp, is what separated the two answers.
  expect(await unitQueue.fail(queueName, held, 'the fixture worker ended')).toBe('failed');
  const recovered = await recoverOrphanedRun(orchestrator, { runId: longRun, at: Date.now() });
  expect(recovered?.state).toBe('failed');
  expect((await readFillEnd(owner, longRun))?.state).toBe('failed');
  expect((await readChain(owner, place.name))?.state).toBe('quiescent');
}), 120_000);

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

test('a re-delivered attempt that cannot build its service ends the run instead of being acknowledged done', async () => await withStorePreparationOwner(async () => {
  const place = fixture('redelivery');
  const { owner, database, storeFolder } = await preparedStore(place);
  const queued = await openFillRunQueue(owner);
  opened.push(queued);
  const press = new KnowledgeProduct({ productFolder: place.folder, storeRoot: place.knowledgeRoot, fillQueued: true });
  products.push(press);
  const started = await press.startFill({ pluginsOnly: true });
  if (!started.started) throw new Error(`the press was refused before the queue: ${started.message}`);
  // The first attempt planned and started the run and then ended without settling it: the run stands `running`, its chain
  // follows it, and the queue holds the retry — what a fill role that was killed leaves behind.
  await advanceRun(database, { runId: started.runId, event: { type: 'plan', at: Date.now(), configuration: 'fixture' } });
  await advanceRun(database, { runId: started.runId, event: { type: 'start', at: Date.now(), stages: 1 } });
  await writeOrchestration(database, async (tx) => {
    await openChainIn(tx, { product: place.name, at: Date.now() });
    await advanceChainIn(tx, { product: place.name, event: { type: 'start', at: Date.now(), runId: started.runId } });
  });
  const first = await claimFillRun(queued);
  if (first === null) throw new Error('the fixture job was not claimed');
  expect(await queued.fail(FILL_RUN_QUEUE, first, 'the fixture attempt ended without settling')).toBe('retry');
  await owner.transaction('write', async (tx) => { await tx.query(`UPDATE pgboss.job SET start_after = clock_timestamp() WHERE id = $1::uuid`, [first.id]); });
  // The environment changed between the two attempts: the store's saved writing agent names an adapter this machine does
  // not have, so the attempt refuses before its service is built. `failRequestedFill` writes no end for a run already
  // begun, so this attempt has no result to publish — and a job it acknowledges as done leaves the press waiting for ever.
  writeFileSync(join(storeFolder, 'writer.json'), `${JSON.stringify({ agent: 'nonesuch', model: 'none' })}\n`);
  let roleDone = false;
  const roleLog: string[] = [];
  const role = driveRole(place, () => roleDone, (line) => { roleLog.push(line); if (roleLog.length > 40) roleLog.shift(); });
  try {
    let end = await readFillEnd(owner, started.runId);
    for (let waited = 0; end === null && waited < 80; waited += 1) {
      await Bun.sleep(250);
      end = await readFillEnd(owner, started.runId);
    }
    if (end === null) throw new Error(`the re-delivered job was acknowledged without a run result: the run got no end; the fill role says: ${roleLog.slice(-4).join(' | ')}`);
    expect(end.state).toBe('failed');
    expect(end.message ?? '').toContain('unknown agent');
    // The end is this request's own answer: the press stops waiting, and what the failed run held is released.
    await press.settled();
    expect((await readRun(database, started.runId))?.state).toBe('failed');
    expect((await readChain(owner, place.name))?.state).toBe('quiescent');
    // The same live press and the same role fill the product again once the environment is put right: no restart, and the
    // page the press answers reads the product it has again.
    rmSync(join(storeFolder, 'writer.json'), { force: true });
    expect((await press.status()).fill.state).toBe('failed');
    const again = await press.startFill({ pluginsOnly: true });
    if (!again.started) throw new Error(`the product refused a fresh fill after its run failed: ${again.message}`);
    await press.settled();
    const endAgain = await readFillEnd(owner, again.runId);
    if (endAgain?.state !== 'succeeded') throw new Error(`the fresh fill ended ${JSON.stringify(endAgain)}; the fill role says: ${roleLog.slice(-6).join(' | ')}`);
    expect(endAgain?.state).toBe('succeeded');
    expect((await listRepositories(owner)).map((repository) => repository.name)).toContain('shop-code');
  } finally {
    roleDone = true;
    await Promise.race([press.settled().catch(() => undefined), Bun.sleep(3_000)]);
    await role.catch(() => undefined);
  }
}), 120_000);

/**
 * The stage of the generation-recovery cases (ALX-2023, madarch-47vw.8): one unit that splits into two children named by
 * the stage itself, and children that answer a draft. A child's id carries no run, so the same split names the same two
 * units in every run of the product — the shape a repeat split of a stand meets, and the shape the seal of a split has to
 * decide: whether the generation it finds belongs to the run that splits now, to a run that ended, or to one still working.
 */
function splittingRecoveryStage(): FillStage {
  return {
    id: 'parts', version: 1, consumes: { required: [], optional: [] }, produces: [],
    configSchema: Type.Object({}), defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [{ id: 'root', scope: 'the repository' }, { id: 'other', scope: 'the other subject' }], coverage: 'planned' }),
    execute: (unit, context) => {
      if (unit.id !== 'root') return { outcome: 'draft' };
      // The attempt after the join finds the set it sealed (decision 0027) and builds on it rather than splitting again.
      if ((context.sealedChildren?.length ?? 0) > 0) return { outcome: 'draft' };
      return { outcome: 'split', children: [{ id: 'left', scope: 'the left half' }, { id: 'right', scope: 'the right half' }] };
    },
  };
}

/** The orchestrator of the generation-recovery cases: the store and queue a fill uses, one stage the case declares. */
async function splitOrchestrator(place: { folder: string; name: string }, owner: Awaited<ReturnType<typeof createDatabaseOwner>>, database: FillStateDatabase): Promise<{ orchestrator: FillOrchestrator }> {
  const queue = await createPgBossQueue({ owner, supervise: false });
  opened.push(queue);
  await queue.declare({ name: 'fill-units', leaseSeconds: DEFAULT_ORCHESTRATOR_LIMITS.attemptSeconds, heartbeatSeconds: DEFAULT_ORCHESTRATOR_LIMITS.heartbeatSeconds, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const orchestrator = createOrchestrator({
    database, registry: new StageRegistry().register(splittingRecoveryStage()), product: place.name,
    queue, queueName: 'fill-units',
    configuration: async () => undefined,
    snapshot: async () => ({ repository: place.folder, defaultBranch: 'main', commit: 'a1b2c3d4', registryHash: 'sha256:fixture' }),
    graph: () => ({ query: async () => [] }), inputs: () => ({}), operations: fixtureOperations(owner),
  });
  return { orchestrator };
}

/**
 * The stand a run that will not finish left behind: the two children of the parent's split, a unit the run never reached,
 * and the parent itself. The run ends the way a process that died ends, so its units keep the states they stood in — the
 * residue the ALX-1717 stand carried after `fill-20261127T212030206Z` (ALX-2025). `end: 'waiting'` leaves the parent
 * waiting for children that will never run, which is the residue the stand's first replay met; `end: 'skipped'` is the
 * stand a run that failed after the settlement fix leaves: the parent and one child stand terminal, beside a live child.
 */
async function staleStand(database: FillStateDatabase, place: { name: string }, seedRun: string, options: { readonly end: 'waiting' | 'skipped' }): Promise<void> {
  const at = Date.now() - 60_000;
  await createRun(database, { runId: seedRun, product: place.name, at });
  await advanceRun(database, { runId: seedRun, event: { type: 'plan', at: at + 1_000, configuration: 'fixture' } });
  await advanceRun(database, { runId: seedRun, event: { type: 'start', at: at + 2_000, stages: 1 } });
  await writeOrchestration(database, async tx => {
    for (const [unitId, scopeKey] of [['parts/root', 'root'], ['parts/other', 'other'], ['parts/left', 'left'], ['parts/right', 'right']] as const) {
      await createUnitIn(tx, { unitId, product: place.name, runId: seedRun, stageId: 'parts', scopeKey, inputsDigest: 'fixture', retries: 2, at });
    }
    await sealSplitIn(tx, { parentUnitId: 'parts/root', parentGeneration: 1, children: [{ unitId: 'parts/left', generation: 1 }, { unitId: 'parts/right', generation: 1 }], at });
    const admitted = await advanceUnitIn(tx, { unitId: 'parts/root', event: { type: 'admit', at, generation: 1 } });
    if (!admitted.ok) throw new Error(`the fixture parent was not admitted: ${admitted.refusal.reason}`);
    const started = await advanceUnitIn(tx, { unitId: 'parts/root', event: { type: 'start', at, generation: 1, fence: 1 } });
    if (!started.ok) throw new Error(`the fixture parent did not start: ${started.refusal.reason}`);
    const waiting = await advanceUnitIn(tx, {
      unitId: 'parts/root',
      event: { type: 'wait-for-children', at, generation: 1, fence: 1, children: [
        { unitId: 'parts/left', generation: 1, published: false, fresh: false, failed: false },
        { unitId: 'parts/right', generation: 1, published: false, fresh: false, failed: false },
      ] },
    });
    if (!waiting.ok) throw new Error(`the fixture parent did not wait for its children: ${waiting.refusal.reason}`);
    if (options.end === 'skipped') {
      // A run that ends by skipping what it holds leaves the parent, a unit it never reached and one child terminal,
      // and the other child live: the residue a stand failed after the settlement fix carries (madarch-47vw.7).
      for (const unitId of ['parts/root', 'parts/other', 'parts/right']) {
        const skipped = await advanceUnitIn(tx, { unitId, event: { type: 'skip', at, cause: 'the fixture run ended with the unit unfinished' } });
        if (!skipped.ok) throw new Error(`the fixture unit ${unitId} did not skip: ${skipped.refusal.reason}`);
      }
    }
  });
  const failed = await advanceRun(database, { runId: seedRun, event: { type: 'fail', at: at + 3_000, cause: 'process-ended', detail: 'the fixture run ended with its units unsettled' } });
  if (!failed.ok) throw new Error(`the fixture run did not end: ${failed.refusal.reason}`);
}

test('a new run retries the units a failed run left live and unpublished', async () => await withStorePreparationOwner(async () => {
  const place = fixture('generations');
  const { owner, database } = await preparedStore(place);
  const { orchestrator } = await splitOrchestrator(place, owner, database);
  const seedRun = 'fill-20261127T212030206Z';
  await staleStand(database, place, seedRun, { end: 'waiting' });

  // What the ended run left before another run plans: the parent waits for children that will never run, and the unit the
  // run never reached stands planned. A generation such a run left live is not a unit another run works.
  expect(await readUnit(database, 'parts/root')).toMatchObject({ runId: seedRun, generation: 1, state: 'waiting_children' });
  expect(await readUnit(database, 'parts/other')).toMatchObject({ runId: seedRun, generation: 1, state: 'planned' });

  // A new run plans the same units. On the base its plan refuses with `unit-in-another-run` and nothing runs; the ended
  // run's generations are released the way that run's own end releases what it holds, and this run's generation opens
  // over each of them under the planning's own transaction.
  const next = 'generations-next';
  await createRun(database, { runId: next, product: place.name, at: Date.now() });
  const planned = await planRun(orchestrator, { runId: next });
  if (planned.outcome !== 'planned') throw new Error(`the new run did not plan over the failed run's units: ${JSON.stringify(planned)}`);
  const plannedUnit = (unitId: string) => planned.units.find((unit) => unit.unitId === unitId);
  expect(plannedUnit('parts/root')).toMatchObject({ generation: 2, state: 'planned', created: true });
  expect(plannedUnit('parts/other')).toMatchObject({ generation: 2, state: 'planned', created: true });

  // The generations the ended run left are cancelled — the only step such a run's generations take — and the run that
  // plans them owns their second generations.
  expect(await readUnitGeneration(database, 'parts/root', 1)).toMatchObject({ runId: seedRun, state: 'cancelled' });
  expect(await readUnitGeneration(database, 'parts/other', 1)).toMatchObject({ runId: seedRun, state: 'cancelled' });
  expect(await readUnitGeneration(database, 'parts/root', 2)).toMatchObject({ runId: next, state: 'planned' });
  expect(await readUnitGeneration(database, 'parts/other', 2)).toMatchObject({ runId: next, state: 'planned' });
  // The children of the ended run's split are nobody's to plan here: the run that plans the parent reaches them through
  // a split of its own, and the ended run's own generation is left as it stood.
  expect(await readUnitGeneration(database, 'parts/left', 1)).toMatchObject({ runId: seedRun, state: 'planned' });

  // The retry says what it replaced, so a person reading the run sees the residue it worked through.
  const events = await readProgress(database, next);
  const plannedEvents = events.filter((event) => event.kind === 'unit-planned').map((event) => event.summary);
  expect(plannedEvents).toEqual(expect.arrayContaining([
    expect.stringContaining('retrying the waiting_children generation 1'),
    expect.stringContaining('retrying the planned generation 1'),
  ]));
}), 120_000);

test('a repeat split seals the children of the run that splits now, across a live and a terminal leftover', async () => await withStorePreparationOwner(async () => {
  const place = fixture('reseal');
  const { owner, database } = await preparedStore(place);
  const { orchestrator } = await splitOrchestrator(place, owner, database);
  const seedRun = 'reseal-seeded';
  await staleStand(database, place, seedRun, { end: 'skipped' });
  // The ended run's parent stands terminal, the way its own settlement left it, so planning the same unit is the retry a
  // failed generation already has; the children of its split are what the repeat seal meets.
  expect(await readUnitGeneration(database, 'parts/root', 1)).toMatchObject({ runId: seedRun, state: 'skipped' });
  expect(await readUnitGeneration(database, 'parts/left', 1)).toMatchObject({ runId: seedRun, state: 'planned' });
  expect(await readUnitGeneration(database, 'parts/right', 1)).toMatchObject({ runId: seedRun, state: 'skipped' });

  const next = 'reseal-next';
  await createRun(database, { runId: next, product: place.name, at: Date.now() });
  const planned = await planRun(orchestrator, { runId: next });
  if (planned.outcome !== 'planned') throw new Error(`the new run did not plan over the failed run's units: ${JSON.stringify(planned)}`);
  // The plan of a run opens its stages too: the run stands `running` and its units are admitted from here.
  expect((await readRun(database, next))?.state).toBe('running');
  await admitUnits(orchestrator, { runId: next });

  // One attempt of this run's parent splits again, over the two children the ended run left. On the base the seal
  // refuses them ("a child of this split is this run's to seal") and the parent blocks instead of splitting.
  const split = await workOnce(orchestrator, { worker: 'reseal-1' });
  expect(split).toMatchObject({ claimed: true, unitId: 'parts/root', result: 'split' });

  // The seal names this run's own generations: one opened over the live leftover, one over the skipped one.
  const sealed = await readSealedChildren(database, 'parts/root', 2);
  expect(sealed.map((child) => child.unitId).sort()).toEqual(['parts/left', 'parts/right']);
  for (const child of sealed) {
    expect(await readUnitGeneration(database, child.unitId, child.generation)).toMatchObject({ runId: next, generation: 2, state: 'planned' });
  }
  // The ended run's generations are released, and the terminal one keeps the record it ended with.
  expect(await readUnitGeneration(database, 'parts/left', 1)).toMatchObject({ runId: seedRun, state: 'cancelled' });
  expect(await readUnitGeneration(database, 'parts/right', 1)).toMatchObject({ runId: seedRun, state: 'skipped' });
  // The parent waits for exactly the generations this run opened, not for the ended run's.
  expect(await readUnit(database, 'parts/root')).toMatchObject({ runId: next, generation: 2, state: 'waiting_children' });

  // The new children run and publish under this run, and the parent joins them and publishes in its turn: the seal
  // bound the parent to children something will finish.
  for (let pass = 0; pass < 8 && (await readUnit(database, 'parts/root'))?.state === 'waiting_children'; pass += 1) {
    await schedulerPass(orchestrator, { runId: next });
    await workOnce(orchestrator, { worker: `reseal-${String(pass + 2)}` });
  }
  expect(await readUnitGeneration(database, 'parts/left', 2)).toMatchObject({ runId: next, state: 'published' });
  expect(await readUnitGeneration(database, 'parts/right', 2)).toMatchObject({ runId: next, state: 'published' });
  expect(await readUnit(database, 'parts/root')).toMatchObject({ runId: next, state: 'published' });
}), 120_000);

/**
 * The state a fill that failed midway leaves (ALX-2077): one pressed run, planned by the product's own plugins, its units
 * unpublished, and the product's chain following it. The press's `fill-runs` job stands in the store's queue, so a case
 * that wants to be the first attempt claims it itself instead of letting the role do it.
 */
async function pressedRunWithUnits(label: string): Promise<{
  place: { folder: string; knowledgeRoot: string; home: string; name: string };
  owner: Awaited<ReturnType<typeof createDatabaseOwner>>;
  database: FillStateDatabase;
  storeFolder: string;
  queue: Awaited<ReturnType<typeof openFillRunQueue>>;
  press: KnowledgeProduct;
  runId: string;
  unfinished: readonly UnitRecord[];
}> {
  const place = fixture(label);
  const { owner, database, storeFolder } = await preparedStore(place);
  const queue = await openFillRunQueue(owner);
  opened.push(queue);
  const press = new KnowledgeProduct({ productFolder: place.folder, storeRoot: place.knowledgeRoot, fillQueued: true });
  products.push(press);
  const started = await press.startFill({ pluginsOnly: true });
  if (!started.started) throw new Error(`the press was refused before the queue: ${started.message}`);
  const graphFolder = join(storeFolder, 'graph');
  const seeded = await createStagesFill({
    product: place.folder, database: owner, runId: started.runId, store: place.home,
    prepareContract: async (contract) => { await requestStorePreparation(graphFolder, contract); },
  });
  const unitQueue = await createPgBossQueue({ owner, supervise: false });
  opened.push(unitQueue);
  await unitQueue.declare({ name: 'fill-units', leaseSeconds: DEFAULT_ORCHESTRATOR_LIMITS.attemptSeconds, heartbeatSeconds: DEFAULT_ORCHESTRATOR_LIMITS.heartbeatSeconds, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const orchestrator = createOrchestrator({
    database: { transaction: owner.transaction.bind(owner), graphContract: seeded.wiring.graphContract },
    registry: seeded.registry, product: seeded.product.name, queue: unitQueue, queueName: 'fill-units',
    configuration: async () => await seeded.wiring.configuration(), snapshot: () => seeded.wiring.snapshot(),
    graph: (ref, tx) => seeded.wiring.graph(ref, tx), inputs: (ref) => seeded.wiring.inputs(ref), operations: seeded.wiring.operations,
  });
  const planned = await planRun(orchestrator, { runId: started.runId });
  if (planned.outcome !== 'planned') throw new Error(`the fixture run did not plan: ${JSON.stringify(planned)}`);
  await writeOrchestration(database, async (tx) => {
    await openChainIn(tx, { product: place.name, at: Date.now() });
    await advanceChainIn(tx, { product: place.name, event: { type: 'start', at: Date.now(), runId: started.runId } });
  });
  const unfinished = (await readRunUnits(database, started.runId)).filter((unit) => unit.state !== 'published');
  if (unfinished.length === 0) throw new Error('the fixture run planned no unfinished unit');
  return { place, owner, database, storeFolder, queue, press, runId: started.runId, unfinished };
}

/** The attempt's own claim, as the fill asks it inside the run's write fence: `isActive` says whether it still holds. */
function claimFence(queue: Awaited<ReturnType<typeof openFillRunQueue>>, job: NonNullable<Awaited<ReturnType<typeof claimFillRun>>>) {
  return async (tx: Parameters<NonNullable<Parameters<typeof failAndSettleRun>[1]['eligible']>>[0]): Promise<boolean> => await queue.isActive(job, tx as unknown as OuterTransaction);
}

test('a lapsed attempt writes none of the cleanup, and the same role carries the run on', async () => await withStorePreparationOwner(async () => {
  const seeded = await pressedRunWithUnits('claim-lapse');
  const { place, owner, database, queue, press, runId, unfinished } = seeded;

  // Attempt 0 is the role's claim, and its claim lapses while it is cleaning up: the queue's sweep hands the job to its
  // retry, which is what ALX-2025 measured when the cleanup outlived the 30 s a claim lives untold.
  const attempt0 = await claimFillRun(queue);
  if (attempt0 === null) throw new Error('the fixture job was not claimed');
  await owner.transaction('write', async (tx) => {
    await tx.query(`UPDATE pgboss.job SET heartbeat_on = clock_timestamp() - interval '60 seconds' WHERE id = $1::uuid`, [attempt0.id]);
  });
  await queue.recover(FILL_RUN_QUEUE);

  // The cleanup the stale attempt asks for is fenced out: no unit is skipped, the run and its chain stand, no end appears.
  const stale = await failAndSettleRun({ database, product: place.name, clock: Date.now }, {
    runId, detail: 'the fixture attempt lost its claim', eligible: claimFence(queue, attempt0),
  });
  expect(stale).toMatchObject({ transitioned: false, ended: false, lapsed: true });
  const held = await readRunUnits(database, runId);
  for (const unit of unfinished) expect(held.find((row) => row.unitId === unit.unitId)?.state).toBe(unit.state);
  expect(held.filter((unit) => unit.state === 'skipped')).toEqual([]);
  expect((await readRun(database, runId))?.state).toBe('running');
  expect((await readChain(owner, place.name))?.context.activeRunId).toBe(runId);
  expect(await readFillEnd(owner, runId)).toBeNull();
  // The settlement of a lapsed attempt is a normal answer, not the crash that ended `--role fill`: the queue refuses it
  // and nothing of the job is written.
  expect(await settleFillRun(queue, attempt0, { ok: false, message: 'the fixture attempt lost its claim' })).toBe('lapsed');

  // The same role — one process, one store — claims Attempt 1 and carries the run to its own end.
  let roleDone = false;
  const roleLog: string[] = [];
  const role = driveRole(place, () => roleDone, (line) => { roleLog.push(line); if (roleLog.length > 40) roleLog.shift(); });
  try {
    let end = await readFillEnd(owner, runId);
    for (let waited = 0; end === null && waited < 180; waited += 1) {
      // The retry waits the queue's own five seconds; the case moves that moment instead of sleeping through it.
      await owner.transaction('write', async (tx) => { await tx.query(`UPDATE pgboss.job SET start_after = clock_timestamp() WHERE name = 'fill-runs' AND state = 'retry'`); });
      await Bun.sleep(1_000);
      end = await readFillEnd(owner, runId);
    }
    // The retry is the same run's own attempt: it drives the units the failed attempt left and ends the run itself.
    if (end?.state !== 'succeeded') throw new Error(`the retry ended ${JSON.stringify(end)}; the run stood ${(await readRun(database, runId))?.state}; the fill role says: ${roleLog.slice(-6).join(' | ')}`);
    expect(end.state).toBe('succeeded');
    expect((await readRun(database, runId))?.state).toBe('succeeded');
    expect((await readChain(owner, place.name))?.state).toBe('quiescent');
    // The graph the press reads holds what the run published, and the page answers.
    const published = (await readRunUnits(database, runId)).filter((unit) => unit.state === 'published');
    expect(published.length).toBeGreaterThan(0);
    expect((await listRepositories(owner)).map((repository) => repository.name)).toContain('shop-code');
    await press.settled();
    expect((await press.status()).fill.state).toBe('done');
    // A fresh fill of the same product, on the same live instance and the same role: no daemon restart.
    const again = await press.startFill({ pluginsOnly: true });
    if (!again.started) throw new Error(`the product refused a fresh fill after the lapsed attempt: ${again.message}`);
    await press.settled();
    expect((await readFillEnd(owner, again.runId))?.state).toBe('succeeded');
  } finally {
    roleDone = true;
    await press.settled().catch(() => undefined);
    await role.catch(() => undefined);
  }
}), 300_000);

test('a cleanup under a live claim skips every unfinished unit, fails the run and writes its end in one write', async () => await withStorePreparationOwner(async () => {
  const { place, owner, database, queue, runId, unfinished } = await pressedRunWithUnits('live-cleanup');
  const attempt0 = await claimFillRun(queue);
  if (attempt0 === null) throw new Error('the fixture job was not claimed');
  const cleaned = await failAndSettleRun({ database, product: place.name, clock: Date.now }, {
    runId, detail: 'the fixture run failed with its units unfinished', eligible: claimFence(queue, attempt0),
  });
  expect(cleaned).toMatchObject({ transitioned: true, ended: true, lapsed: false });
  // Every unfinished unit is skipped, in the same write that fails the run: nothing is left half-cleaned.
  const held = await readRunUnits(database, runId);
  for (const unit of unfinished) expect(held.find((row) => row.unitId === unit.unitId)?.state).toBe('skipped');
  expect((await readRun(database, runId))?.state).toBe('failed');
  expect((await readChain(owner, place.name))?.state).toBe('quiescent');
  expect((await readFillEnd(owner, runId))?.state).toBe('failed');
  // The progress names every skipped unit and the run's own failure, once each.
  const events = await readProgress(database, runId);
  expect(events.filter((event) => event.kind === 'unit-skipped').length).toBe(unfinished.length);
  expect(events.filter((event) => event.kind === 'run-failed').length).toBe(1);
  // The claim the attempt holds is still its own after the cleanup: the write did not outlive it.
  expect(await owner.transaction('snapshot', async (tx) => await queue.isActive(attempt0, tx))).toBe(true);
}), 120_000);

test('a cleanup that refuses at its last write leaves the run, its units and its chain as they stood', async () => await withStorePreparationOwner(async () => {
  const { place, owner, database, queue, runId, unfinished } = await pressedRunWithUnits('atomic-cleanup');
  const attempt0 = await claimFillRun(queue);
  if (attempt0 === null) throw new Error('the fixture job was not claimed');
  // The run's own failure summary carries an invalid mention token, which the graph refuses: the cleanup's last write
  // throws. Written unit by unit, the skips had already committed and the run stood `running` with every unit skipped for
  // ever — the residue ALX-2025 measured on the stand (60 units skipped, the run and its chain stuck).
  let refusal: unknown;
  try {
    await failAndSettleRun({ database, product: place.name, clock: Date.now }, {
      runId, detail: 'the run failed: [[uid:<lowercase hyphenated UUID>]]', eligible: claimFence(queue, attempt0),
    });
  } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toContain('[[uid:');
  const held = await readRunUnits(database, runId);
  for (const unit of unfinished) expect(held.find((row) => row.unitId === unit.unitId)?.state).toBe(unit.state);
  expect(held.filter((unit) => unit.state === 'skipped')).toEqual([]);
  expect((await readRun(database, runId))?.state).toBe('running');
  expect((await readChain(owner, place.name))?.context.activeRunId).toBe(runId);
  expect(await readFillEnd(owner, runId)).toBeNull();
}), 120_000);

/**
 * The moment a case and the code it drives meet on: the code waits here, the case reads what it needs, and only then says
 * go on. Both halves are promises, so neither side races the other's speed.
 */
function meeting(): { arrived: Promise<void>; arrive: () => void; released: Promise<void>; release: () => void } {
  let arrive = (): void => undefined;
  let release = (): void => undefined;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { arrived, arrive, released, release };
}

test('the claim of a queued fill is beaten from its setup through its settlement, and that attempt settles it', async () => await withStorePreparationOwner(async () => {
  const place = fixture('claim-span');
  const { owner } = await preparedStore(place);
  const observed = await openFillRunQueue(owner);
  opened.push(observed);
  const press = new KnowledgeProduct({ productFolder: place.folder, storeRoot: place.knowledgeRoot, fillQueued: true });
  products.push(press);
  const started = await press.startFill({ pluginsOnly: true });
  if (!started.started) throw new Error(`the press was refused before the queue: ${started.message}`);

  /** The pressed fill's job as the queue holds it: one job per product until the attempt that claimed it settles it. */
  const job = async (): Promise<{ id: string; state: string; attempt: number; lease: number; beat: string } | undefined> => await owner.transaction('snapshot', async (tx) =>
    (await tx.query<{ id: string; state: string; attempt: number; lease: number; beat: string }>(`SELECT id::text AS id, state, retry_count AS attempt, expire_seconds AS lease, heartbeat_on::text AS beat FROM pgboss.job WHERE name = 'fill-runs' ORDER BY created_on DESC LIMIT 1`)).rows[0]);
  /** Whether the queue still holds that attempt, read by the queue's own rule rather than by this case's copy of it. */
  const holds = async (claimed: { id: string; attempt: number; lease: number }): Promise<boolean> => await owner.transaction('snapshot', async (tx) =>
    await observed.isActive({ id: claimed.id, attempt: claimed.attempt, leaseSeconds: claimed.lease, queue: FILL_RUN_QUEUE, retries: 1, data: { product: place.folder, store: '', runId: started.runId } }, tx));

  // Two moments the role is held at while it drives the press: its own store's open for the run — before the run has a
  // heartbeat of its own — and the run's owner closing, after that heartbeat stopped and with the queue's settlement owed.
  const duringSetup = meeting();
  const beforeSettlement = meeting();
  let storesOpened = 0;
  let done = false;
  const roleLog: string[] = [];
  const role = runFillRole({
    knowledgeRoot: place.knowledgeRoot,
    log: (line) => { roleLog.push(line); if (roleLog.length > 40) roleLog.shift(); },
    idle: () => done,
    // The role opens a store once to watch it and once for the run it drives: the run's own owner is held at both ends.
    openStore: async (folder) => {
      const inner = await createDatabaseOwner({ store: folder, connectOnly: true });
      if ((storesOpened += 1) === 1) return inner;
      duringSetup.arrive();
      await duringSetup.released;
      const runOwner: DatabaseOwner = {
        location: inner.location,
        ready: inner.ready,
        allowConcurrentSnapshots: inner.allowConcurrentSnapshots,
        hasVector: inner.hasVector,
        transaction: (kind, work, options) => inner.transaction(kind, work, options),
        run: (work) => inner.run(work),
        exec: (text) => inner.exec(text),
        onClose: (work) => inner.onClose(work),
        close: async () => { beforeSettlement.arrive(); await beforeSettlement.released; await inner.close(); },
      };
      return runOwner;
    },
  });
  try {
    // A refresh during setup: the run has not started, so nothing but the role's own beat can touch this claim. The
    // queue lets a claim untouched for 30 s be handed to its next attempt, and the beat is what says this one is alive —
    // so a still-active claim past that window, with a newer touch, is the attempt keeping its own job.
    await duringSetup.arrived;
    const claimed = await job();
    if (claimed === undefined) throw new Error('the role claimed no fill-runs job');
    expect(claimed).toMatchObject({ state: 'active', attempt: 0 });
    await Bun.sleep(33_000);
    const refreshed = await job();
    expect(refreshed).toMatchObject({ id: claimed.id, state: 'active', attempt: 0 });
    expect(refreshed?.beat).not.toBe(claimed.beat);
    expect(await holds(refreshed!)).toBe(true);
    duringSetup.release();

    // A refresh after the run's own heartbeat stopped and while the queue's settlement is still owed: its end is written,
    // the run's heartbeat went with its service, and this claim is still whole past the same 30 s window.
    await beforeSettlement.arrived;
    expect(await readFillEnd(owner, started.runId)).not.toBeNull();
    const ended = await job();
    await Bun.sleep(33_000);
    const stillHeld = await job();
    expect(stillHeld).toMatchObject({ id: claimed.id, state: 'active', attempt: 0 });
    expect(stillHeld?.beat).not.toBe(ended?.beat);
    expect(await holds(stillHeld!)).toBe(true);
    beforeSettlement.release();

    // Released, the attempt that still holds the claim settles it: the real queue completes this attempt — it does not
    // hand the job to a retry of a claim that went quiet during the cleanup.
    let settled = await job();
    for (let waited = 0; settled?.state !== 'completed' && waited < 120; waited += 1) { await Bun.sleep(100); settled = await job(); }
    if (settled?.state !== 'completed') throw new Error(`the attempt that held the claim settled nothing: the job stands ${JSON.stringify(settled)}; the fill role says: ${roleLog.slice(-6).join(' | ')}`);
    expect(settled).toMatchObject({ id: claimed.id, state: 'completed', attempt: 0 });
    done = true;
    await press.settled();
    expect((await press.status()).fill.state).toBe('done');
  } finally {
    // The role is let go of whatever happened, and neither of its two waits can hold the file's cleanup: a case that fails
    // above is still a case that ends.
    done = true;
    duringSetup.release();
    beforeSettlement.release();
    await Promise.race([press.settled().catch(() => undefined), Bun.sleep(10_000)]);
    await Promise.race([role.catch(() => undefined), Bun.sleep(20_000)]);
  }
}), 300_000);
