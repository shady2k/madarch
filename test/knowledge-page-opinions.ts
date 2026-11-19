import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import type { EntityRefDraft, KeyValueDraft } from '../src/graph/contract.js';
import { newUid } from '../src/graph/uid.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { PAYMENTS_SERVICE, PAY } from './knowledge-fixture.js';

/**
 * Publish explicit fixture opinions; no fixture parser infers a page from file bytes. A page's mentions are edges
 * (decision 0036, section 3): the publisher states the page's values and no `mentions` field.
 */
export interface FixtureOpinion {
  readonly kind: string;
  /** A keyless kind's stable identity: the fixture states the entity again without making a second one. */
  readonly uid?: string;
  readonly key: Record<string, KeyValueDraft>;
  readonly values: Record<string, unknown>;
}

export interface FixtureEdge {
  readonly kind: string;
  readonly from: EntityRefDraft;
  readonly to: EntityRefDraft;
}

/** The role a sample product names as its audience: keyless, so one identity stands across the fixture's calls. */
const SAMPLE_ROLE_UID = newUid();

export async function publishFixtureOpinions(folder: string, knowledgeRoot: string, opinions: readonly FixtureOpinion[], edges: readonly FixtureEdge[] = []): Promise<void> {
  const read = readKinds(folder);
  if (!read.present) throw new Error(`${folder}/madarch/catalog.yaml:1: fixture kinds are absent`);
  const contract = graphContractOf(read.manifest);
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRoot)), connectOnly: true });
  try {
    await owner.ready;
    for (const opinion of opinions) {
      await owner.transaction('write', async (tx) => {
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, {
          vertices: [{ kind: opinion.kind, key: opinion.key, ...(opinion.uid === undefined ? {} : { uid: opinion.uid }), values: opinion.values, producer: 'fixture', producerVersion: '1' }],
          removals: [],
        });
      });
    }
    if (edges.length > 0) {
      await owner.transaction('write', async (tx) => {
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, {
          vertices: [],
          edges: edges.map((edge) => ({ ...edge, producer: 'fixture', producerVersion: '1' })),
          removals: [],
        });
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
  // The rewritten catalogue keys a product and a domain by `name` and declares the fields each one holds: a product its
  // purpose, status and vision, a domain its description and type. A page's body is the agent's text; these samples are
  // a person's statement of the same facts.
  const products = pages.filter((page) => page.kind === 'product');
  // A product's audience is an edge to the role it names (catalogue `product-audience`, product → role), not a field:
  // the sample page states the edge to the role `product`, and the keyless role stands by the fixture's stable identity.
  const role: FixtureOpinion[] = products.length === 0 ? [] : [{ kind: 'role', uid: SAMPLE_ROLE_UID, key: {}, values: { name: 'product', label: 'product' } }];
  const audience: FixtureEdge[] = products.map((page) => ({
    kind: 'product-audience',
    from: { kind: 'product', key: { name: page.slug } },
    to: { kind: 'role', key: {}, uid: SAMPLE_ROLE_UID },
  }));
  await publishFixtureOpinions(folder, knowledgeRoot, [...pages.map((page) => ({
    kind: page.kind, key: { name: page.slug },
    values: page.kind === 'product'
      ? { purpose: page.body, status: 'in service', vision: page.body }
      : { description: page.body, type: 'core' },
  })), ...role], audience);
}
