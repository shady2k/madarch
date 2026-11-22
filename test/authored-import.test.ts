import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { personBinding, personOperationBinding } from '../src/graph/system-installation.js';
import { bindGraphProducer, registerGraphPrincipal, producerIdentityOf } from '../src/graph/producer-binding.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';
import { afterAll, expect, test } from 'bun:test';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { publishValidatedManifests, validateProductManifests, startupBinding } from '../src/graph/manifest-publication.js';
import { authoredImportHost, authoredImportReceipts } from '../src/adapters/authored-import.js';
import { authoredHistoryPresent } from '../src/adapters/authored-import.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { writeContractOf } from '../src/graph/graph-writes.js';
import { authoredEntity } from '../src/graph/authored.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds } from '../src/product/manifest/kinds.js';
import { importAuthored, AUTHORED_ARCHIVE } from '../src/knowledge/import-authored.js';
import { graphMarkdownEntities } from '../src/knowledge/markdown.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { createTestDatabaseOwner } from './test-database.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'authored-import-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'));
  mkdirSync(join(folder, 'templates'));
  mkdirSync(join(folder, 'old'));
  writeFileSync(join(folder, 'templates/page.liquid'), '');
  writeFolderManifest(folder, `kinds:
  note:
    source: graph
    origin: person
    
    import-folder: old
    fields:
      - { name: legacy_id, type: text, nullable: true, producers: [person] }
      - { name: title, type: text, producers: [person] }
      - { name: body, type: text, nullable: true, producers: [person] }
      - { name: front, type: json, nullable: true, producers: [person], schema: { '$schema': 'https://json-schema.org/draft/2020-12/schema', type: object, additionalProperties: { anyOf: [{ type: string }, { type: array, items: { type: string } }] } } }
    key: []
`);
  const initialized = Bun.spawnSync(['git', '-C', folder, 'init', '-q']);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
  const committed = Bun.spawnSync(['git', '-C', folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
  if (committed.exitCode !== 0) throw new Error(committed.stderr.toString());
  return folder;
}

test('imports bytes once, retries an interrupted archive, reports bad items and excludes person Markdown', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  const manifest = parsed.manifest;
  expect(manifest.findings).toEqual([]);
  const bytes = Buffer.from('\uFEFF---\r\nid: note:kept\r\nkind: note\r\ntitle: Kept\r\nextra: [one, two]\r\n---\r\nExact body.\r\n');
  writeFileSync(join(folder, 'old/kept.md'), bytes);
  writeFileSync(join(folder, 'old/bad.md'), 'not an entity');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(manifest)) });
  try {
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    // A blocked archive exercises a committed import whose source has not yet moved.
    writeFileSync(join(folder, AUTHORED_ARCHIVE.split('/')[0]!), 'blocked');
    const first = await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(manifest)), 'authored-import')), manifest, '', 'reader');
    expect({ imported: first.imported, errors: first.errors }).toMatchObject({ imported: ['old/kept.md'] });
    expect(first.archived).toEqual([]);
    expect(first.errors.map((error) => error.file)).toEqual([join(folder, 'old/bad.md'), join(folder, 'old/kept.md')]);
    expect(readFileSync(join(folder, 'old/kept.md'))).toEqual(bytes);
    rmSync(join(folder, '.madarch'));
    const retry = await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(manifest)), 'authored-import')), manifest, '', 'reader');
    expect(retry.imported).toEqual([]);
    expect(retry.archived).toEqual(['old/kept.md']);
    expect(existsSync(join(folder, 'old/kept.md'))).toBe(false);
    const receipts = await owner.transaction('snapshot', tx => authoredImportReceipts(tx));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(receipts[0]!.words);
    expect(Buffer.from(receipt.bytes, 'base64')).toEqual(bytes);
    expect(receipt.path).toBe('old/kept.md');
    expect((await owner.transaction('snapshot', async (tx) => (await tx.query("SELECT n.* FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='note'")).rows)).length).toBe(1);
    expect((await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(manifest)), 'authored-import')), manifest, '', 'reader')).imported).toEqual([]);
    const oldManifest = { ...manifest, kinds: new Map([...manifest.kinds].map(([name, decl]) => [name, { ...decl, source: 'markdown' as const, folder: 'old' }])) };
    expect(await graphMarkdownEntities({ list: async () => { throw new Error('person-authored kinds must not enter the page materializer'); } }, oldManifest)).toEqual({ entities: [], findings: [] });
  } finally { await owner.close(); }
}, 15000);

test('failed publication keeps the file and creates no receipt; symlinks are reported', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  writeFileSync(join(folder, 'old/missing-title.md'), '---\nid: note:x\nkind: note\n---\nbody');
  // Required custom fields cannot be silently omitted by the importer.
  const kindFile = join(folder, 'madarch/kinds/fixture/fixture/note.yaml');
  const rawKind = parseYaml(readFileSync(kindFile, 'utf8'));
  rawKind.fields.push({ name: 'required', type: 'text', producers: ['person'] });
  writeFileSync(kindFile, stringifyYaml(rawKind));
  const updated = readKinds(folder);
  if (!updated.present) throw new Error(`${kindFile}:1: fixture manifest missing after required field change`);
  const manifest = updated.manifest;
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(manifest)) });
  try {
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    const result = await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(manifest)), 'authored-import')), manifest, '', 'reader');
    expect(result.imported).toEqual([]);
    expect(result.errors[0]!.message).toContain('required');
    expect(existsSync(join(folder, 'old/missing-title.md'))).toBe(true);
    expect(await owner.transaction('snapshot', tx => authoredImportReceipts(tx))).toEqual([]);
  } finally { await owner.close(); }
}, 15000);

test('an archive link is refused without losing the committed source or writing outside', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  writeFileSync(join(folder, 'old/kept.md'), '---\nid: note:kept\nkind: note\ntitle: Kept\n---\nBody');
  const outside = mkdtempSync(join(root, 'outside-'));
  symlinkSync(outside, join(folder, '.madarch'));
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(parsed.manifest)) });
  try {
    await createOneGraphSchema(owner, withManifestContract(graphContractOf(parsed.manifest)));
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    const result = await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(parsed.manifest)), 'authored-import')), parsed.manifest, '', 'reader');
    expect(result.imported).toEqual(['old/kept.md']);
    expect(result.archived).toEqual([]);
    expect(result.errors[0]!.message).toContain('symbolic link');
    expect(existsSync(join(folder, 'old/kept.md'))).toBe(true);
    expect(existsSync(join(outside, 'imported-authored'))).toBe(false);
  } finally { await owner.close(); }
}, 15000);

test('authored history guard is false before writing and remains true after deleting the entity', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(parsed.manifest)) });
  try {
    await createOneGraphSchema(owner, withManifestContract(graphContractOf(parsed.manifest)));
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    expect(await authoredHistoryPresent(owner)).toBe(false);
    await publishValidatedManifests(owner, validated.value);
    // Engine manifest publication is not person-authored history.
    expect(await authoredHistoryPresent(owner)).toBe(false);
    const person = await personBinding(owner, graphContractOf(parsed.manifest));
    const created = await owner.transaction('write', async (tx) => {
      return await authoredEntity(tx, parsed.manifest, '', person, 'create', 'note', { values: { title: 'Kept' } }); });
    expect(await authoredHistoryPresent(owner)).toBe(true);
    await owner.transaction('write', async (tx) => {
      return await authoredEntity(tx, parsed.manifest, '', person, 'delete', 'note', { uid: created.entity!.uid }); });
    expect(await authoredHistoryPresent(owner)).toBe(true);
  } finally { await owner.close(); }
}, 15000);

test('changed source after a committed archive failure edits the receipt uid and retains both byte versions', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  const original = Buffer.from('---\nid: note:kept\nkind: note\ntitle: Original\n---\nFirst body\n');
  const changed = Buffer.from('---\r\nid: note:kept\r\nkind: note\r\ntitle: Changed\r\n---\r\nSecond body\r\n');
  writeFileSync(join(folder, 'old/kept.md'), original);
  writeFileSync(join(folder, '.madarch'), 'blocked');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(parsed.manifest)) });
  try {
    await createOneGraphSchema(owner, withManifestContract(graphContractOf(parsed.manifest)));
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    const contract = withAssertionContract(writeContractOf(parsed.manifest));
    const firstPerson = await personOperationBinding(owner, contract, 'authored-import');
    const secondUid = newUid();
    await owner.transaction('write', async tx => {
      await startupBinding(tx, contract, 'person-fixture');
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'person', uid: secondUid, key: {}, values: { installation: 'second-importer-fixture' }, producer: 'system', producerVersion: '1' }], removals: [] });
    });
    const secondPrincipal = await registerGraphPrincipal(owner, { producer: `person:${secondUid}`, version: '1', uid: secondUid, kind: 'person', sourceUid: secondUid, principalUid: secondUid, scope: 'second-importer-fixture' });
    const secondPerson = bindGraphProducer(owner, contract, { principal: secondPrincipal,
      vertices: Object.fromEntries(contract.vertex.filter(kind => ['note', 'system.authored-import'].includes(kind.name)).map(kind => [kind.name, kind.fields.map(field => field.name)])),
      edges: Object.fromEntries(contract.edge.filter(kind => ['system.authored-import-target', 'system.authored-import-source', 'system.authored-import-product'].includes(kind.name)).map(kind => [kind.name, kind.fields.map(field => field.name)])),
    });
    const first = await importAuthored(folder, authoredImportHost(owner, firstPerson), parsed.manifest, '', 'first-reader');
    expect(first.imported).toEqual(['old/kept.md']);
    expect(first.archived).toEqual([]);
    const uid = await owner.transaction('snapshot', async (tx) => (await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='note'")).rows[0]!.uid);
    writeFileSync(join(folder, 'old/kept.md'), changed);
    rmSync(join(folder, '.madarch'));
    const retry = await importAuthored(folder, authoredImportHost(owner, secondPerson), parsed.manifest, '', 'second-reader');
    expect(retry.errors).toEqual([]);
    expect(retry.imported).toEqual(['old/kept.md']);
    expect(retry.archived).toEqual(['old/kept.md']);
    const nodes = await owner.transaction('snapshot', async (tx) => (await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='note'")).rows);
    expect(nodes).toEqual([{ uid }]);
    const held = await owner.transaction('snapshot', async (tx) => await authoredEntity(tx, parsed.manifest, '', undefined, 'read', 'note', { uid }));
    expect(held.entity!.assertions.filter(assertion => assertion['property'] === 'title').map(assertion => assertion['value'])).toEqual(['Original', 'Changed']);
    expect(new Set(held.entity!.assertions.map(assertion => assertion['author']))).toEqual(new Set([producerIdentityOf(firstPerson).principalUid, secondUid]));
    expect(new Set(held.entity!.assertions.map(assertion => assertion['source']))).toEqual(new Set([producerIdentityOf(firstPerson).sourceUid, secondUid]));
    const receipts = await owner.transaction('snapshot', async (tx) => (await authoredImportReceipts(tx)).map(row => JSON.parse(row.words)));
    expect(receipts.map((receipt) => Buffer.from(receipt.bytes, 'base64'))).toEqual([original, changed]);
    expect(receipts.map((receipt) => [receipt.path, receipt.legacyId])).toEqual([['old/kept.md', 'note:kept'], ['old/kept.md', 'note:kept']]);
    // A second interrupted retry of the changed bytes must not publish them twice.
    writeFileSync(join(folder, 'old/kept.md'), changed);
    expect((await importAuthored(folder, authoredImportHost(owner, secondPerson), parsed.manifest, '', 'second-reader')).imported).toEqual([]);
  } finally { await owner.close(); }
}, 15000);

test('byte-only retry retains the changed exact source once without another opinion', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  const original = Buffer.from('---\nid: note:kept\nkind: note\ntitle: Kept\n---\nBody\n');
  const changed = Buffer.from('---\n# Imported source comment\nid: note:kept\nkind: note\ntitle: Kept\n---\nBody\n');
  writeFileSync(join(folder, 'old/kept.md'), original);
  writeFileSync(join(folder, '.madarch'), 'blocked');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(parsed.manifest)) });
  try {
    await createOneGraphSchema(owner, withManifestContract(graphContractOf(parsed.manifest)));
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(parsed.manifest)), 'authored-import')), parsed.manifest, '', 'reader');
    writeFileSync(join(folder, 'old/kept.md'), changed);
    const retry = await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(parsed.manifest)), 'authored-import')), parsed.manifest, '', 'reader');
    expect(retry.imported).toEqual(['old/kept.md']);
    const receipts = await owner.transaction('snapshot', async (tx) => (await authoredImportReceipts(tx)).map(row => JSON.parse(row.words)));
    expect(receipts.map((receipt) => Buffer.from(receipt.bytes, 'base64'))).toEqual([original, changed]);
    expect((await importAuthored(folder, authoredImportHost(owner, await personOperationBinding(owner, withAssertionContract(writeContractOf(parsed.manifest)), 'authored-import')), parsed.manifest, '', 'reader')).imported).toEqual([]);
    const held = await owner.transaction('snapshot', async (tx) => await authoredEntity(tx, parsed.manifest, '', undefined, 'list', 'note'));
    expect(held.entities).toHaveLength(1);
    expect(held.entities![0]!.assertions.filter(assertion => assertion['property'] === 'title')).toHaveLength(1);
  } finally { await owner.close(); }
}, 15000);
