/**
 * The product's own page (decision 0036, section 6: the home is an entity): the start states the product's name from its
 * manifest, so the home page opens on the product itself and not on an empty graph. Its description and every other
 * value are the graph's, written by an agent or a person; the start copies no README or vision text into them.
 */
import { withSpan } from '../obs/trace.js';
import { readKindAssertions } from './records.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { entityDraft, evidenceOf, writeContractOf } from './graph-writes.js';
import { bindStartupWriter, readPublishedManifest } from './manifest-publication.js';
import { publishGraphDrafts } from './write.js';
import type { KeyValueDraft, VertexRemovalDraft } from './contract.js';
import type { ProductEntity } from '../product/manifest.js';

/** States the product's own page: its name, as the manifest states it now. */
export async function writeProductEntity(owner: DatabaseOwner, entity: ProductEntity | undefined): Promise<void> {
  if (entity === undefined) return;
  await withSpan('graph.startEntity', {}, async () => await owner.transaction('write', async (tx) => {
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined) throw new Error(`${import.meta.path}:22: the startup page requires a published manifest`);
    const contract = await bindStartupWriter(tx, writeContractOf(manifest), 'start');
    const catalogue = await readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['declaration']);
    const evidenceTargets = [...new Set(catalogue.flatMap(row => row.selectedAssertions.flatMap(assertion => assertion.evidence)))];
    if (evidenceTargets.length === 0) throw new Error(`${import.meta.path}:26: startup requires the published manifest's snapshot evidence`);
    const evidence = await tx.query<{ uid: string; kind: string; key: Record<string, KeyValueDraft> }>('SELECT n.uid::text,k.name AS kind,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=ANY($1::uuid[])', [evidenceTargets]);
    const { draft, vertex } = entityDraft(contract, entity, { producer: 'start', version: '1' }, evidenceOf(evidence.rows.map(target => ({ target: { kind: target.kind, key: target.key, uid: target.uid } }))));
    const records = await readKindAssertions(tx, 'vertex', vertex.name, [], { contract });
    const removals: VertexRemovalDraft[] = records.filter(one => JSON.stringify(one.key) !== JSON.stringify(entity.key)).map(one => ({kind: entity.kind,key:one.key as Record<string,KeyValueDraft>,uid:one.uid,producer:'start'}));
    await publishGraphDrafts(tx, contract, { vertices: [draft], removals }, 1, { author: 'start@1' });
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  }));
}
