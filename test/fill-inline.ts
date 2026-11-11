import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
/**
 * One pass of the files producer in the test's own process: a page reads the graph, and a write to the product reaches a
 * page only at the next pass. The fill is `runFill`, the same one the wiki's button asks for; running it here keeps a
 * suite of many writes fast and free of a child process per press.
 */
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill } from '../src/fill/run.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';

/** Fills a product in this process and waits for it; a failed run is thrown with its own words. */
export async function fillInProcess(product: string, home: string, storeRoot?: string): Promise<void> {
  const store = productStoreFolder(product, storeRoot ?? knowledgeRootOf(home));
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const result = await runFill({ product, database: owner, store, home, runId: `test-${String(Date.now())}`, prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
    if (!result.ok) throw new Error(`the fill was refused (${result.code}): ${result.reason}`);
  } finally {
    await owner.close().catch(() => undefined);
  }
}
