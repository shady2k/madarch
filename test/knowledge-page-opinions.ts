import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import type { KeyValueDraft } from '../src/graph/contract.js';
import { ensureVertex, publishOpinion, journalFor, writeJournal } from '../src/graph/write.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { PAYMENTS_SERVICE, PAY } from './knowledge-fixture.js';

/** Publish explicit fixture opinions; no fixture parser infers a page from file bytes. */
export async function publishFixtureOpinions(folder: string, knowledgeRoot: string, opinions: readonly { kind: string; key: Record<string, KeyValueDraft>; values: Record<string, unknown> }[]): Promise<void> {
  const read = readKinds(folder);
  if (!read.present) throw new Error(`${folder}/madarch/kinds.yaml:1: fixture kinds are absent`);
  const contract = graphContractOf(read.manifest);
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRoot)), connectOnly: true });
  try {
    await owner.ready;
    for (const opinion of opinions) {
      await owner.transaction('write', async (tx) => {
        const journal = journalFor('fixture@1');
        const node = await ensureVertex(tx, contract, { kind: opinion.kind, key: opinion.key }, 1, journal);
        await publishOpinion(tx, contract, { kind: opinion.kind, nodeId: node.nodeId, uid: node.uid, producer: 'fixture', producerVersion: '1', values: opinion.values }, 1, journal);
        await writeJournal(tx, journal);
      });
    }
  } finally {
    await owner.close();
  }
}

export async function publishSamplePageOpinions(folder: string, knowledgeRoot: string, suppliedPages?: readonly { kind: string; slug: string; title: string; file: string; body: string; relates: readonly string[]; sources: readonly string[] }[]): Promise<void> {
  const pages = suppliedPages ?? [
    { kind: 'product', slug: 'shop', title: 'Online shop', file: 'docs/product.md', body: 'The shop takes orders from shoppers and charges their cards through a payments service.', relates: [PAYMENTS_SERVICE], sources: ['docs/vision.md'] },
    { kind: 'domain', slug: 'payment', title: 'Payment', file: 'docs/domains/payment.md', body: 'Payments are charged through one of two providers chosen by configuration.', relates: [PAYMENTS_SERVICE, PAY], sources: ['docs/requirements.md'] },
  ];
  await publishFixtureOpinions(folder, knowledgeRoot, pages.map((page) => ({
    kind: page.kind, key: { slug: page.slug },
    values: { title: page.title, file: page.file, body: page.body, relates: page.relates, sources: page.sources, body_line: 1, producer: 'fixture', statements: [], mentions: [], digest: 'fixture', links: [], findings: [], ungrounded: [] },
  })));
}
