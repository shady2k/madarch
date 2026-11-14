/**
 * The product's own page (decision 0036, section 6: the home is an entity): the start states the product's name from its
 * manifest, so the home page opens on the product itself and not on an empty graph. Its description and every other
 * value are the graph's, written by an agent or a person; the start copies no README or vision text into them.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { putEntityOpinion } from './graph-writes.js';
import type { ProductEntity } from '../product/manifest.js';

/** States the product's own page: its name, as the manifest states it now. */
export async function writeProductEntity(owner: DatabaseOwner, entity: ProductEntity | undefined): Promise<void> {
  if (entity === undefined) return;
  // One opinion per producer per field: stating it again supersedes the one the last start stated.
  await putEntityOpinion(owner, { producer: 'start', version: '1' }, { kind: entity.kind, key: entity.key, values: entity.values, evidence: entity.evidence });
}
