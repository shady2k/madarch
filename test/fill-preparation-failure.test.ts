/**
 * A fill that fails before its host begins (ALX-464, root R4, item 3): the run a caller asked for is ended `failed` with
 * the cause, never left standing `created`, which every reader shows as `running`. The run row is the api role's: it is
 * written when the person presses the fill, and the fill process that then cannot prepare the store must end it.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { startKnowledgeFill } from '../src/knowledge/fill-run.js';
import { runFill } from '../src/fill/run.js';
import { createRun, readRun } from '../src/graph/fill-state.js';
import { readFillEnd } from '../src/graph/fill-orchestration.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { readProduct } from '../src/product/manifest.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { writeProduct } from './fixtures/code-stages/repository.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { prepareStoreAcceptanceFixture } from '../scripts/clean-install-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

test('a fill that fails at store preparation ends its requested run failed, with the cause', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-preparation-'));
  const owner = await createTestDatabaseOwner();
  try {
    const { product } = writeProduct(root);
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const read = readProduct(product);
    if (!read.ok) throw new Error(read.message);
    const database = { transaction: owner.transaction.bind(owner), graphContract: withAssertionContract(await readPinnedGraphContract(product)) };
    // The press writes the run; the fill process then cannot prepare the store.
    await createRun(database, { runId: 'prep-failed', product: read.product.name, at: Date.now() });
    const refusal = 'the store cannot prepare this contract';
    await expect(runFill({ product, database: owner, runId: 'prep-failed', store: join(root, 'store'), prepareContract: async () => { throw new Error(refusal); } })).rejects.toThrow(refusal);
    expect((await readRun(database, 'prep-failed'))?.state).toBe('failed');
    // The cause stands with the run's end, where the press's page and `madarch trace` read it.
    expect(await readFillEnd(database, 'prep-failed')).toMatchObject({ runId: 'prep-failed', state: 'failed', message: refusal });
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

/**
 * A fill whose stage plan refuses (a plugin-free catalogue, whose kinds no producer fills) is a fill that began: the run
 * row stands `planning` and the press waits for its end. The process that ran it ends it `failed` with the refusal, so the
 * page names the cause, where a run left standing answers `queued` for ever and the walk's own bound is the only thing
 * that ends it (measured 2026-11-26: the clean-install walk polled 180 000 ms for a run that had failed after 2 s).
 */
test('a fill whose stage plan refuses ends its run failed, with the cause, never standing planning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-plan-refused-'));
  // The store the fill opens, and reads again after: the run closes its own owner with itself.
  const fillStore = join(root, 'fill-store');
  const owner = await createTestDatabaseOwner({ store: fillStore, database: 'fill' });
  try {
    const product = join(root, 'product');
    mkdirSync(product);
    // The clean-install walk's own fixture: the starter catalogue reduced to the kinds the engine reads, with no plugin,
    // so nothing in the manifest produces them and the stage's plan refuses before a unit is planned.
    seedStarterSet(product, 'everything');
    prepareStoreAcceptanceFixture(product);
    writeFileSync(join(product, 'workspace.yaml'), ['schemaVersion: 1', 'id: 5b0f1c3e-2d44-4a91-9f60-0c7a1e8b2d55', 'name: plugin-free-product', ''].join('\n'));
    const git = (...parameters: string[]): void => { execFileSync('git', parameters, { cwd: product, stdio: 'ignore' }); };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fill Fixture');
    git('config', 'user.email', 'fill@example.invalid');
    git('add', '-A');
    git('commit', '-qm', 'the plugin-free product of the store walk');
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const read = readProduct(product);
    if (!read.ok) throw new Error(read.message);
    const database = { transaction: owner.transaction.bind(owner), graphContract: withAssertionContract(await readPinnedGraphContract(product)) };
    await createRun(database, { runId: 'plan-refused', product: read.product.name, at: Date.now() });
    // The fill the press asked for, run the way the api role runs it: the process that claims the run holds it.
    const run = await startKnowledgeFill({ productFolder: product, storeFolder: fillStore, runId: 'plan-refused', database: owner, unconfined: true });
    const answer = await run.done;
    await run.close();
    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('nothing the fill was asked for has a producer');
    // The run the press asked for never stands live after its own process ended it, and its end names the cause. The
    // fill's own owner is closed with the run, so the store is read again, as the page that shows the run does.
    const reader = await createTestDatabaseOwner({ store: fillStore, database: 'fill' });
    try {
      const readBack = { transaction: reader.transaction.bind(reader), graphContract: database.graphContract };
      expect((await readRun(readBack, 'plan-refused'))?.state).toBe('failed');
      expect(await readFillEnd(readBack, 'plan-refused')).toMatchObject({ runId: 'plan-refused', state: 'failed', message: answer.message });
    } finally {
      await reader.close();
    }
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
