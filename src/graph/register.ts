/**
 * Registers a product's vocabulary from the registry a caller passes
 * (decision 0028, "Tables"; decision 0026). The engine hard-codes no product
 * kind: the rows this writes are the only place a product's kinds and relation
 * types exist in the store. An encoding is never reused, so registering a key
 * again changes nothing, and registering it with other flags is refused.
 */
import { GraphError } from './errors.js';
import type { WriteContext } from './versions.js';
import { checkRegistry, type GraphRegistry } from './vocabulary.js';

export async function registerVocabulary(ctx: WriteContext, registry: GraphRegistry): Promise<{ kinds: number; relations: number }> {
  checkRegistry(registry);
  let kinds = 0;
  let relations = 0;
  for (const [index, key] of registry.kinds.entries()) {
    const made = await ctx.tx.query(`INSERT INTO node_kind (key, namespace, registered_at) VALUES ($1, 'product', $2::timestamptz) ON CONFLICT (key) DO NOTHING RETURNING id`, [key, ctx.at]);
    if (made.rows.length > 0) kinds += 1;
    else {
      const existing = await ctx.tx.query<{ namespace: string }>('SELECT namespace FROM node_kind WHERE key = $1', [key]);
      if (existing.rows[0]?.namespace !== 'product') throw new GraphError('register vocabulary', `kinds[${index}]`, `"${key}" is already registered outside the product namespace`, registry.origin);
    }
  }
  for (const [index, relation] of registry.relations.entries()) {
    const discriminated = relation.discriminated === true;
    const positioned = relation.positioned === true;
    const made = await ctx.tx.query(
      `INSERT INTO relation_type (key, namespace, discriminated, positioned, registered_at) VALUES ($1, 'product', $2, $3, $4::timestamptz) ON CONFLICT (key) DO NOTHING RETURNING id`,
      [relation.key, discriminated, positioned, ctx.at],
    );
    if (made.rows.length > 0) relations += 1;
    else {
      const existing = await ctx.tx.query<{ namespace: string; discriminated: boolean; positioned: boolean }>('SELECT namespace, discriminated, positioned FROM relation_type WHERE key = $1', [relation.key]);
      const row = existing.rows[0];
      if (row?.namespace !== 'product' || row.discriminated !== discriminated || row.positioned !== positioned) {
        throw new GraphError('register vocabulary', `relations[${index}]`, `"${relation.key}" is already registered with other settings (discriminated ${row?.discriminated}, positioned ${row?.positioned}); an encoding is never reused or changed`, registry.origin);
      }
    }
  }
  return { kinds, relations };
}
