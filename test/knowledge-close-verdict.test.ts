import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * Closing a product while its graph verdicts read the store (madarch-8bdc.2.9). `graphVerdicts` owns a connection of
 * its own for the snapshot, so a product that closes while that run is in flight used to return with the connection
 * still open — and a test's `afterAll` then removed the store's folder under it, leaving PostgreSQL's FATAL as an
 * unhandled `error` between tests (the inter-test postmaster-exit error of the full suite).
 *
 * The case holds the graph's tables in one connection, so the verdict's snapshot has to wait, and asks whether
 * `close()` returns while the verdict's own `DatabaseOwner` is still open. It must not: `close()` waits for the run.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { GIT_CONTRACT } from '../src/fill/stages/git-contract.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { withStorePreparationOwner, requestStorePreparation } from '../src/product/store-preparation.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { graphVerdictFile } from '../src/knowledge/graph-verdict-store.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** Whether a backend waits for one of the graph's tables: the verdict's snapshot does, while the case holds them. */
async function waitsForTheGraph(owner: DatabaseOwner): Promise<boolean> {
  const held = await owner.run(async (tx) => await tx.query<{ waiting: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND relation IN ('entity'::regclass, 'node'::regclass)) AS waiting`,
  ));
  return held.rows[0]?.waiting === true;
}

describe('closing a product while its graph verdicts read the store', () => {
  test('close waits for a verdict run whose own store owner is still open', async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-close-verdict-'));
    let owner: DatabaseOwner | undefined;
    let product: KnowledgeProduct | undefined;
    try {
      const draft = createDraft({ home: join(work, 'home'), name: 'close-shop', gitEnv: gitEnv(IDENTITY) });
      if (draft.outcome !== 'created') throw new Error(`the product was not made: ${JSON.stringify(draft)}`);
      const storeRoot = join(work, 'store');
      product = new KnowledgeProduct({ productFolder: draft.folder, storeRoot });
      // The store the verdict run opens for its snapshot, with the one graph's tables and the kinds it reads.
      owner = await createTestDatabaseOwner({ store: storeDatabasePath(productStoreFolder(draft.folder, storeRoot)), btreeGist: true });
      await prepareStore(owner, { contract: GIT_CONTRACT });

      let releaseLock!: () => void;
      let holdsTheGraph!: () => void;
      const theGraphIsHeld = new Promise<void>((resolve) => { holdsTheGraph = resolve; });
      const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
      let lock: Promise<void> | undefined;
      let verdict: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      try {
        // The page side: one transaction holding the graph's tables, so the verdict's snapshot waits on a real lock.
        lock = owner.transaction('write', async (tx) => {
          await tx.query('LOCK TABLE entity IN ACCESS EXCLUSIVE MODE');
          await tx.query('LOCK TABLE node IN ACCESS EXCLUSIVE MODE');
          holdsTheGraph();
          await gate;
        });
        await theGraphIsHeld;

        verdict = product.graphVerdicts({ force: true });
        const deadline = Date.now() + 15_000;
        while (!(await waitsForTheGraph(owner))) {
          if (Date.now() > deadline) throw new Error('the graph verdict never asked for the tables the lock holds');
          await Bun.sleep(10);
        }

        let closed = false;
        closing = product.close().then(() => { closed = true; });
        await Bun.sleep(250);
        // The verdict's DatabaseOwner is still open and waiting for the graph: close() must not have returned.
        expect(closed, 'close() returned while the graph verdict run still held its store owner open').toBe(false);
        expect(await waitsForTheGraph(owner), 'the verdict was no longer waiting for the graph').toBe(true);
      } finally {
        releaseLock?.();
        await lock?.catch(() => undefined);
        await verdict?.catch(() => undefined);
        await closing?.catch(() => undefined);
      }
    } finally {
      await product?.close().catch(() => undefined);
      await owner?.close().catch(() => undefined);
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});

test('a standalone fill does not start validation, while an explicit request still computes verdicts', async () => {
  const work = mkdtempSync(join(tmpdir(), 'madarch-inline-verdict-'));
  let product: KnowledgeProduct | undefined;
  try {
    const draft = createDraft({ home: join(work, 'home'), name: 'inline-shop', gitEnv: gitEnv(IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(`the product was not made: ${JSON.stringify(draft)}`);
    const storeRoot = join(work, 'store');
    let judgeCalls = 0;
    product = new KnowledgeProduct({ productFolder: draft.folder, storeRoot, graphJev: {
      async judge(items) { judgeCalls += 1; return items.map((item) => ({ id: item.id, verdict: 'unsure', reason: 'fixture' })); },
    } });
    await withStorePreparationOwner(async () => {
      await requestStorePreparation(storeDatabasePath(productStoreFolder(draft.folder, storeRoot)), await readPinnedGraphContract(draft.folder));
      expect(await product!.startFill({ targets: { kinds: ['code.repository', 'code.directory', 'code.file', 'code.commit', 'code.author'] } })).toMatchObject({ started: true });
      await product!.settled();
    });
    expect(product.fillState()).toMatchObject({ state: 'done' });
    const file = graphVerdictFile(productStoreFolder(draft.folder, storeRoot));
    expect(judgeCalls).toBe(0);
    expect(existsSync(file)).toBe(false);
    // Close is the ownership boundary: no unsolicited task may remain to write a cache after the fill caller leaves.
    await product.close();
    expect(judgeCalls).toBe(0);
    expect(existsSync(file)).toBe(false);
    product = new KnowledgeProduct({ productFolder: draft.folder, storeRoot });
    const context = spyOn(product, 'context');
    try {
      const verdict = await product.graphVerdicts();
      expect(verdict.rows.length).toBeGreaterThan(0);
      expect(existsSync(file)).toBe(true);
      expect(context).toHaveBeenCalledTimes(1);
    } finally { context.mockRestore(); }
  } finally {
    await product?.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
