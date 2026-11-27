import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
/**
 * One pass of the files producer in the test's own process: a page reads the graph, and a write to the product reaches a
 * page only at the next pass. The fill is `runFill`, the same one the wiki's button asks for; running it here keeps a
 * suite of many writes fast and free of a child process per press.
 */
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill } from '../src/fill/run.js';
import type { FillRunResult, RefusedFillRun } from '../src/fill/orchestrator-host.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';

/** Temporary diagnostic for ALX-1714: which awaited step of the fill does not return. Not for a pull request. */
const probeOrigin = performance.now();
const probeElapsed = () => (performance.now() - probeOrigin).toFixed(0);
const probe = (label: string) => {
  console.log(`PROBE fill-inline +${probeElapsed()}ms ${label}`);
};
async function measured<T>(label: string, work: () => Promise<T>): Promise<T> {
  const begun = performance.now();
  probe(`${label} begin`);
  const beat = setInterval(() => {
    probe(`${label} heartbeat (${(performance.now() - begun).toFixed(0)}ms in this step)`);
  }, 5_000);
  try {
    return await work();
  } finally {
    clearInterval(beat);
    probe(`${label} end ${(performance.now() - begun).toFixed(0)}ms`);
  }
}

/** Fills a product in this process and waits for it; a failed run is thrown with its own words. */
export async function fillInProcess(product: string, home: string, storeRoot?: string): Promise<FillRunResult> {
  const store = productStoreFolder(product, storeRoot ?? knowledgeRootOf(home));
  const owner = await measured('owner: open', () => createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true }));
  try {
    await measured('store: read the pinned contract', () => readPinnedGraphContract(product)).then((contract) =>
      measured('store: prepare', () => prepareStore(owner, { contract })),
    );
    const result = await measured('runFill', () =>
      runFill({ product, database: owner, store, home, runId: `test-${String(Date.now())}`, prepareContract: async (contract) => { await measured('runFill: prepareContract', () => prepareStore(owner, { contract })); } }),
    );
    return requireSucceededFill(result);
  } finally {
    await measured('owner: close', () => owner.close().catch(() => undefined));
  }
}

export function requireSucceededFill(result: FillRunResult | RefusedFillRun): FillRunResult {
  if (!result.ok) throw new Error(`the fill was refused (${result.code}): ${result.reason}`);
  if (result.state !== 'succeeded' || !result.settled) {
    throw new Error(`the fill did not succeed (run ${result.runId}, state ${result.state}, settled ${String(result.settled)})`);
  }
  return result;
}
