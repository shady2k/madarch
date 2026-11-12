/** Connects to a prepared graph without changing its schema. */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { requireSchema } from '../adapters/store-readiness.js';
import { graphSchemaStamp } from '../adapters/schemas/graph-definition.js';
import { EMPTY_CONTRACT, generatedTableName, type GraphContract } from './contract.js';

export { FILE_PATH_TABLE, FILE_BLOB_TABLE, FILE_ENTRY_TABLE } from './file-tables.js';

/** Requires the graph prepared for this contract; reset and reconciliation belong to store preparation. */
export async function createOneGraphSchema(owner: DatabaseOwner, contract: GraphContract = EMPTY_CONTRACT): Promise<{ reset: boolean }> {
  await requireSchema(owner, 'one-graph', graphSchemaStamp(contract));
  const tables = ['entity', 'context', 'node', 'edge', 'operation', 'unresolved_reference', 'file_entry',
    generatedTableName('path', 'dictionary'), generatedTableName('blob', 'dictionary'),
    ...contract.vertex.map((kind) => generatedTableName(kind.name, 'vertex')),
    ...contract.edge.map((kind) => generatedTableName(kind.name, 'edge')),
    ...contract.dictionary.map((kind) => generatedTableName(kind.name, 'dictionary'))];
  const missing = await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ name: string }>(
      `SELECT requested.name FROM unnest($1::text[]) AS requested(name)
       WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = requested.name)`, [tables]);
    return found.rows.map((row) => row.name);
  });
  if (missing.length > 0) throw new Error(`src/graph/one-graph.ts: missing prepared graph tables ${missing.join(', ')}; run madarch start for this store before connecting`);
  return { reset: false };
}
