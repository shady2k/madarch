import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { testAgentBinding, testHostBinding } from './host-binding-fixture.js';
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
    const startBinding = await testHostBinding(owner, writeContractOf(manifest), 'start', '0');
    await owner.transaction('write', (tx) => publishGraphDrafts(tx, writeContractOf(manifest), {
      vertices: ['old-heading', 'old-heading-at-revision'].map((slug) => ({ kind: 'product', key: { slug }, values: { title: 'Old heading' }, producer: startBinding.producer, producerVersion: startBinding.version, evidence })), removals: [],
    }, 1, { binding: startBinding }));
    await publishValidatedManifests(owner, read.value);
    if (personOpinion) await putEntityOpinion(owner, await testAgentBinding(owner, writeContractOf(manifest)), { kind: 'product', key: { slug: 'old-heading' }, values: { title: 'Person title' }, evidence });
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
    // The manifest name is the label; the stable key is the manifest id, never the name.
    expect(current).toMatchObject({ slug: 'stable-product-id', title: 'sample' });
    if (personOpinion) expect(data.allProduct.edges.find((edge) => edge.node.slug === 'old-heading')!.node.title).toBe('Person title');
    expect(data.bootstrap.home).toEqual({ id: current.id });
    const home = await executeGraphql(owner, { folder: folder, manifest }, { query: 'query ($id: ID!) { entity(id: $id) { label } }', variables: { id: data.bootstrap.home.id } });
    expect(home.body).toEqual({ data: { entity: { label: 'sample' } } });
    const minimal = productEntityOf(folder, { home: { name: 'product', source: 'graph', key: ['slug'], fields: [{ name: 'title' }] } }, 'a'.repeat(40));
    expect(minimal?.values).toEqual({ title: 'sample' });
  } finally { await owner.close(); }
}, 30_000);

test('renaming the product keeps one node, updates its label, and keeps a person opinion on it', async () => {
  const folder = join(root, 'renamed');
  mkdirSync(folder);
  mkdirSync(join(folder, 'madarch'));
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-product-id\nname: first-name\n');
  writeFolderManifest(folder, `kinds:
  product:
    source: graph
    title: title
    key: [slug]
    fields:
      - { name: slug, type: text, producers: [start] }
      - { name: title, type: text, producers: [start] }
      - { name: body, type: text, producers: [person] }
`);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  const manifest = read.value.manifest;
  const options = { store: join(folder, 'store'), graphContract: writeContractOf(manifest) };
  let owner = await createTestDatabaseOwner(options);
  const evidence = [{ repository: folder, path: '.', lineStart: 1, lineEnd: 1, commit: 'a'.repeat(40) }];
  try {
    await publishValidatedManifests(owner, read.value);
    await putEntityOpinion(owner, await testAgentBinding(owner, writeContractOf(manifest)), { kind: 'product', key: { slug: 'stable-product-id' }, values: { body: 'Person description' }, evidence });
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-product-id\nname: second-name\n');
    await owner.close();
    owner = await createTestDatabaseOwner(options);
    await publishValidatedManifests(owner, read.value);
    const answer = await executeGraphql(owner, { folder: folder, manifest }, { query: '{ bootstrap { home { id } } allProduct { totalCount edges { node { id slug title body } } } }' });
    expect((answer.body as MessageBody).errors).toBeUndefined();
    const data = (answer.body as MessageBody).data as { bootstrap: { home: { id: string } }; allProduct: { totalCount: number; edges: { node: { id: string; slug: string; title: string; body: string } }[] } };
    expect(data.allProduct.totalCount).toBe(1);
    const current = data.allProduct.edges[0]!.node;
    expect(current).toMatchObject({ slug: 'stable-product-id', title: 'second-name', body: 'Person description' });
    const home = await executeGraphql(owner, { folder: folder, manifest }, { query: 'query ($id: ID!) { entity(id: $id) { label } }', variables: { id: data.bootstrap.home.id } });
    expect(home.body).toEqual({ data: { entity: { label: 'second-name' } } });
  } finally { await owner.close(); }
}, 30_000);
