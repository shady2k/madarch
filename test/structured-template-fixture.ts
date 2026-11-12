import type { TemplatePart } from '../src/knowledge/template.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { ensureVertex, journalFor, publishOpinion, writeJournal } from '../src/graph/write.js';
import { readKinds } from '../src/product/manifest/kinds.js';

/** Publishes the fixture's explicit structured template; it never reads or expands Liquid source. */
export async function publishFixtureTemplate(owner: DatabaseOwner, product: string, path: string, parts: readonly TemplatePart[] = [{ type: 'block', name: 'properties', params: { title: 'Details' }, line: 1 }]): Promise<void> {
  const read = readKinds(product);
  if (!read.present) throw new Error(`${product}/madarch/kinds.yaml:1: fixture manifest is absent`);
  const contract = graphContractOf(read.manifest);
  await owner.transaction('write', async (tx) => {
    const journal = journalFor('fixture@1');
    const node = await ensureVertex(tx, contract, { kind: 'template', key: { path } }, 1, journal);
    await publishOpinion(tx, contract, {
      kind: 'template', nodeId: node.nodeId, producer: 'fixture', producerVersion: '1',
      values: { template_parts: parts },
    }, 1, journal);
    await writeJournal(tx, journal);
  });
}

/** Native repository tests publish their expected block structure without parsing starter Liquid. */
export async function publishRepositoryTemplates(product: string, home: string, knowledgeRoot = knowledgeRootOf(home)): Promise<void> {
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(product, knowledgeRoot)), connectOnly: true });
  const block = (name: Extract<TemplatePart, { type: 'block' }>['name'], params: Record<string, string> = {}): TemplatePart => ({ type: 'block', name, params, line: 1 });
  try {
    await publishFixtureTemplate(owner, product, 'templates/repository.liquid', [
      block('treemap', { title: 'Repository map', colour: 'heat', window: '90d' }),
      block('repository', { title: 'Repository' }), block('files', { title: 'Files' }),
      block('history', { title: 'History' }), block('folder', { title: 'Root' }),
    ]);
    await publishFixtureTemplate(owner, product, 'templates/directory.liquid', [
      block('treemap', { title: 'Folder map', colour: 'heat', window: '90d' }),
      block('folder', { title: 'Files and folders' }), block('files', { title: 'Files' }),
    ]);
    await publishFixtureTemplate(owner, product, 'templates/file.liquid', [block('file-page')]);
    await publishFixtureTemplate(owner, product, 'templates/commit.liquid', [block('properties', { title: 'Details' })]);
    await publishFixtureTemplate(owner, product, 'templates/author.liquid', [block('properties', { title: 'Details' }), block('history', { title: 'History' })]);
  } finally {
    await owner.close();
  }
}
