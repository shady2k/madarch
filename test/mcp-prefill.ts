/**
 * A 0028 graph written by the extract driver into the folder a served session
 * keeps its store in (madarch-8bdc.2.5, item 1). The served path of this step
 * answers from the record store, and the working-tree layer over a base graph
 * (`src/mcp/layer.ts`) is still exercised by `test/mcp-start`, `test/mcp-server`,
 * `test/mcp-review` and `test/mcp-lock`: those cases stand on a graph the
 * driver wrote, so they write it here first instead of asking the record fill
 * for facts it does not publish.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore } from '../src/graph/index.js';

/** Writes the driver's graph of one checkout at its HEAD into `<folder>/graph`. */
export async function writeDriverGraph(folder: string, repository: string): Promise<void> {
  mkdirSync(join(folder, 'graph'), { recursive: true });
  const owner = createPGliteDatabaseOwner({ path: join(folder, 'graph'), btreeGist: true, relaxedDurability: true });
  try {
    const store = createGraphStore(owner);
    await store.createSchema();
    await fillGraph({ owner, store, repository, extractors: TREE_EXTRACTORS });
  } finally {
    await owner.close();
  }
}
