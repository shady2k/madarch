/**
 * The product's own page (decision 0036, section 6: the home is an entity): the start states what the product's own
 * files say it is — its name and the first paragraph of its first repository's README — so the home page opens on the
 * product itself and not on an empty graph. The start's opinion supersedes the one it stated before, so a README that
 * changed is read again on the next start.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { entityDraft, evidenceOf, writeContractOf } from './graph-writes.js';
import { readPublishedManifest } from './manifest-publication.js';
import { publishGraphDrafts } from './write.js';
import type { KeyValueDraft, VertexRemovalDraft } from './contract.js';
import type { ProductEntity } from '../product/manifest.js';

/** States the product's own page: its name and the README's first paragraph, as the files state them now. */
export async function writeProductEntity(owner: DatabaseOwner, entity: ProductEntity | undefined): Promise<void> {
  if (entity === undefined) return;
  await owner.transaction('write', async (tx) => {
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined) throw new Error('the startup page requires a published manifest');
    const contract = writeContractOf(manifest);
    const { draft, vertex } = entityDraft(contract, entity, { producer: 'start', version: '1' }, evidenceOf(entity.evidence));
    // Older starts keyed the product by a heading (and older revisions by a revision identity). Withdraw only their
    // start opinions; another producer's opinion is not startup's to retire.
    const held = await tx.query<{ key: Record<string, KeyValueDraft>; uid: string }>(
      `SELECT DISTINCT n.key, n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id
       JOIN "${vertex.table}" p ON p.node_id = n.id
       WHERE e.name = $1 AND n.context_id = 1 AND NOT n.removed AND p.state = 'open'
         AND split_part(p.said_by, '@', 1) = 'start' AND n.key <> $2::jsonb`,
      [entity.kind, JSON.stringify(entity.key)],
    );
    const removals: VertexRemovalDraft[] = held.rows.map((one) => ({ kind: entity.kind, key: one.key, uid: one.uid, producer: 'start' }));
    await publishGraphDrafts(tx, contract, { vertices: [draft], removals }, 1, { author: 'start@1' });
  });
}
