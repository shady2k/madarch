/**
 * Whether the graph holds a generated table for a kind (decision 0034, item 14): the check a product makes after its
 * manifest changed, and the one that says a kind taken out of the manifest took its table with it. The table's name is
 * derived from the kind's name alone (`generatedTableName`), so the check never needs the manifest that made it.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { generatedTableName } from './contract.js';

/** Whether the kind's vertex table stands in the store. */
export async function hasGeneratedTable(owner: DatabaseOwner, kind: string): Promise<boolean> {
  const table = generatedTableName(kind, 'vertex');
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ there: boolean }>("SELECT to_regclass($1) IS NOT NULL AS there", [table]);
    return found.rows[0]?.there === true;
  });
}
