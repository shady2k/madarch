/**
 * A fill that fails before its host begins (ALX-464, root R4, item 3): the run a caller asked for is ended `failed` with
 * the cause, never left standing `created`, which every reader shows as `running`. The run row is the api role's: it is
 * written when the person presses the fill, and the fill process that then cannot prepare the store must end it.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { runFill } from '../src/fill/run.js';
import { createRun, readRun } from '../src/graph/fill-state.js';
import { readFillEnd } from '../src/graph/fill-orchestration.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { readProduct } from '../src/product/manifest.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { writeProduct } from './fixtures/code-stages/repository.js';
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
