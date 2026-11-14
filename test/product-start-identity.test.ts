import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { writeContractOf, putEntityOpinion } from '../src/graph/graph-writes.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { productEntityOf } from '../src/product/manifest.js';
import { publishGraphDrafts } from '../src/graph/write.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-start-identity-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.each([false, true])('startup keeps stable identity and current home while preserving person opinions: %s', async (personOpinion) => {
  const folder = join(root, String(personOpinion));
  mkdirSync(folder);
  mkdirSync(join(folder, 'madarch'));
  mkdirSync(join(folder, 'repos/library'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-product-id\nname: sample\nrepos:\n  - name: library\n    linked: true\n');
  writeFolderManifest(folder, `kinds:
  product:
    source: graph
    title: title
    key: [slug]
    fields:
      - { name: slug, type: text, producers: [start] }
      - { name: title, type: text, producers: [start] }
`);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  const manifest = read.value.manifest;
  const options = { store: join(folder, 'store'), graphContract: writeContractOf(manifest) };
  let owner = await createTestDatabaseOwner(options);
  const evidence = [{ repository: folder, path: 'repos/library/README.md', lineStart: 1, commit: 'a'.repeat(40) }];
  try {
    writeFileSync(join(folder, 'repos/library/README.md'), '# Old heading\n');
    // Stores written before stable identity can hold several heading or revision identities.
    await owner.transaction('write', (tx) => publishGraphDrafts(tx, writeContractOf(manifest), {
      vertices: ['old-heading', 'old-heading-at-revision'].map((slug) => ({ kind: 'product', key: { slug }, values: { title: 'Old heading' }, producer: 'start', producerVersion: '0', evidence })), removals: [],
    }));
    await publishValidatedManifests(owner, read.value);
    if (personOpinion) await putEntityOpinion(owner, { producer: 'person', version: '1' }, { kind: 'product', key: { slug: 'old-heading' }, values: { title: 'Person title' }, evidence });
    writeFileSync(join(folder, 'repos/library/README.md'), '# New heading\n');
    await owner.close();
    owner = await createTestDatabaseOwner(options);
    await publishValidatedManifests(owner, read.value);
    await publishValidatedManifests(owner, read.value);
    const answer = await executeGraphql(owner, { folder: folder, manifest }, { query: '{ bootstrap { home { id } } allProduct { totalCount edges { node { id slug title } } } }' });
    const body = answer.body as MessageBody;
    expect(body.errors).toBeUndefined();
    const data = body.data as { bootstrap: { home: { id: string } }; allProduct: { totalCount: number; edges: { node: { id: string; slug: string; title: string } }[] } };
    expect(data.allProduct.totalCount).toBe(personOpinion ? 2 : 1);
    const current = data.allProduct.edges.find((edge) => edge.node.slug === 'stable-product-id')!.node;
    expect(current).toMatchObject({ slug: 'stable-product-id', title: 'New heading' });
    if (personOpinion) expect(data.allProduct.edges.find((edge) => edge.node.slug === 'old-heading')!.node.title).toBe('Person title');
    expect(data.bootstrap.home).toEqual({ id: current.id });
    const home = await executeGraphql(owner, { folder: folder, manifest }, { query: 'query ($id: ID!) { entity(id: $id) { label } }', variables: { id: data.bootstrap.home.id } });
    expect(home.body).toEqual({ data: { entity: { label: 'New heading' } } });
    const minimal = productEntityOf(folder, { home: { name: 'product', source: 'graph', key: ['slug'], fields: [{ name: 'title' }] } }, 'a'.repeat(40));
    expect(minimal?.values).toEqual({ title: 'New heading' });
  } finally { await owner.close(); }
}, 30_000);
