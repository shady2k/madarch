import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createRecordSchema } from '../src/graph/index.js';
import { ensureVertex, publishOpinion } from '../src/graph/write.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { PAYMENTS_SERVICE, PAY } from './knowledge-fixture.js';

/** Publish explicit fixture opinions; no fixture parser infers a page from file bytes. */
export async function publishSamplePageOpinions(folder: string, knowledgeRoot: string): Promise<void> {
  const read = readKinds(folder);
  if (!read.present) throw new Error(`${folder}/madarch/kinds.yaml:1: fixture kinds are absent`);
  const contract = graphContractOf(read.manifest);
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRoot)), btreeGist: true });
  try {
    await owner.ready;
    await createRecordSchema(owner, contract);
    const pages = [
      { kind: 'product', slug: 'shop', title: 'Online shop', file: 'docs/product.md', body: 'The shop takes orders from shoppers and charges their cards through a payments service.', relates: [PAYMENTS_SERVICE], sources: ['docs/vision.md'] },
      { kind: 'domain', slug: 'payment', title: 'Payment', file: 'docs/domains/payment.md', body: 'Payments are charged through one of two providers chosen by configuration.', relates: [PAYMENTS_SERVICE, PAY], sources: ['docs/requirements.md'] },
    ];
    for (const page of pages) {
      const vertex = contract.vertex.find((kind) => kind.name === page.kind);
      if (vertex === undefined) throw new Error(`${read.manifest.file}:1: fixture requires ordinary ${page.kind} opinions`);
      const values = { ...page, body_line: 1, producer: 'fixture', statements: [], mentions: [], digest: 'fixture', links: [], findings: [], ungrounded: [] };
      await owner.transaction('write', async (tx) => {
        const node = await ensureVertex(tx, contract, { kind: page.kind, key: Object.fromEntries(vertex.key.map((name) => {
          if (name !== 'slug') throw new Error(`${read.manifest.file}:1: ${page.kind}.${name}: fixture requires a slug natural key`);
          return [name, page.slug];
        })) });
        await publishOpinion(tx, contract, { kind: page.kind, nodeId: node.nodeId, uid: node.uid, producer: 'fixture', producerVersion: '1', values: Object.fromEntries(vertex.fields.filter((field) => !vertex.key.includes(field.name)).map((field) => [field.name, values[field.name as keyof typeof values]])) });
      });
    }
  } finally {
    await owner.close();
  }
}
