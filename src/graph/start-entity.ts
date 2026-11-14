/**
 * The product's own page (decision 0036, section 6: the home is an entity): the start states what the product's own
 * files say it is — its name and the first paragraph of its first repository's README — so the home page opens on the
 * product itself and not on an empty graph. The start's opinion supersedes the one it stated before, so a README that
 * changed is read again on the next start.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { putEntityOpinion } from './graph-writes.js';
import type { ProductEntity } from '../product/manifest.js';

/** States the product's own page: its name and the README's first paragraph, as the files state them now. */
export async function writeProductEntity(owner: DatabaseOwner, entity: ProductEntity | undefined): Promise<void> {
  if (entity === undefined) return;
  // One opinion per producer per field: stating it again supersedes the one the last start stated.
  await putEntityOpinion(owner, { producer: 'start', version: '1' }, { kind: entity.kind, key: entity.key, values: entity.values, evidence: entity.evidence });
}
