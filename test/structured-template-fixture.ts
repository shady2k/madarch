import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { ensureVertex, journalFor, publishOpinion, writeJournal } from '../src/graph/write.js';
import { readKinds } from '../src/product/manifest/kinds.js';

/** Publishes the fixture's explicit structured template; it never reads or expands Liquid source. */
export async function publishFixtureTemplate(owner: DatabaseOwner, product: string, path: string): Promise<void> {
  const read = readKinds(product);
  if (!read.present) throw new Error(`${product}/madarch/kinds.yaml:1: fixture manifest is absent`);
  const contract = graphContractOf(read.manifest);
  await owner.transaction('write', async (tx) => {
    const journal = journalFor('fixture@1');
    const node = await ensureVertex(tx, contract, { kind: 'template', key: { path } }, 1, journal);
    await publishOpinion(tx, contract, {
      kind: 'template', nodeId: node.nodeId, producer: 'fixture', producerVersion: '1',
      values: { template_parts: [{ type: 'block', name: 'properties', params: { title: 'Details' }, line: 1 }] },
    }, 1, journal);
    await writeJournal(tx, journal);
  });
}
