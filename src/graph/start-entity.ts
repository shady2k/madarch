/**
 * The product's own page (decision 0036, section 6: the home is an entity): the start states what the product's own
 * files say it is — its name and the first paragraph of its first repository's README — so the home page opens on the
 * product itself and not on an empty graph. A graph that already holds the entity is left as it is.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { putEntityOpinion } from './graph-writes.js';
import type { ProductEntity } from '../product/manifest.js';

/** Whether the graph already holds one entity of the kind the product's page opens. */
async function holdsProduct(owner: DatabaseOwner, kind: string): Promise<boolean> {
  return await owner.run(async (tx) => {
    const found = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM node n JOIN entity en ON en.id = n.entity_id WHERE en.name = $1 AND n.context_id = 1 AND NOT n.removed`,
      [kind],
    );
    return Number(found.rows[0]?.n ?? 0) > 0;
  });
}

/** States the product's own page at start, when the graph holds none: the name and the README's first paragraph. */
export async function writeProductEntity(owner: DatabaseOwner, entity: ProductEntity | undefined): Promise<void> {
  if (entity === undefined) return;
  if (await holdsProduct(owner, entity.kind)) return;
  await putEntityOpinion(owner, { producer: 'start', version: '1' }, { kind: entity.kind, key: entity.key, values: entity.values, evidence: entity.evidence });
}
