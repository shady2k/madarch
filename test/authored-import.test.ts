import { afterAll, expect, test } from 'bun:test';
import { authoredHistoryPresent } from '../src/adapters/authored-import.js';
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
      - { name: front, type: json, nullable: true, producers: [person] }
    key: []
`);
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
  const owner = await createTestDatabaseOwner({ graphContract: graphContractOf(manifest) });
  try {
    await createOneGraphSchema(owner, graphContractOf(manifest));
    // A blocked archive exercises a committed import whose source has not yet moved.
    writeFileSync(join(folder, AUTHORED_ARCHIVE.split('/')[0]!), 'blocked');
    const first = await importAuthored(folder, owner, manifest, '', 'reader');
    expect({ imported: first.imported, errors: first.errors }).toMatchObject({ imported: ['old/kept.md'] });
    expect(first.archived).toEqual([]);
    expect(first.errors.map((error) => error.file)).toEqual([join(folder, 'old/bad.md'), join(folder, 'old/kept.md')]);
    expect(readFileSync(join(folder, 'old/kept.md'))).toEqual(bytes);
    rmSync(join(folder, '.madarch'));
    const retry = await importAuthored(folder, owner, manifest, '', 'reader');
    expect(retry.imported).toEqual([]);
    expect(retry.archived).toEqual(['old/kept.md']);
    expect(existsSync(join(folder, 'old/kept.md'))).toBe(false);
    const receipts = await owner.transaction('snapshot', async (tx) => (await tx.query<{words:string}>('SELECT words FROM operation')).rows);
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(receipts[0]!.words);
    expect(Buffer.from(receipt.bytes, 'base64')).toEqual(bytes);
    expect(receipt.path).toBe('old/kept.md');
    expect((await owner.transaction('snapshot', async (tx) => (await tx.query('SELECT * FROM node')).rows)).length).toBe(1);
    expect((await importAuthored(folder, owner, manifest, '', 'reader')).imported).toEqual([]);
    const oldManifest = { ...manifest, kinds: new Map([...manifest.kinds].map(([name, decl]) => [name, { ...decl, source: 'markdown' as const, folder: 'old' }])) };
    expect(await graphMarkdownEntities({ list: async () => { throw new Error('person-authored kinds must not enter the page materializer'); } }, oldManifest)).toEqual({ entities: [], findings: [] });
  } finally { await owner.close(); }
}, 15000);

test('failed publication keeps the file and creates no receipt; symlinks are reported', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  const manifest = parsed.manifest;
  writeFileSync(join(folder, 'old/missing-title.md'), '---\nid: note:x\nkind: note\n---\nbody');
  // Required custom fields cannot be silently omitted by the importer.
  manifest.kinds.get('note')!.fields = [...manifest.kinds.get('note')!.fields!, { name: 'required', type: 'text', producers: ['person'] }];
  const owner = await createTestDatabaseOwner({ graphContract: graphContractOf(manifest) });
  try {
    await createOneGraphSchema(owner, graphContractOf(manifest));
    const result = await importAuthored(folder, owner, manifest, '', 'reader');
    expect(result.imported).toEqual([]);
    expect(result.errors[0]!.message).toContain('required');
    expect(existsSync(join(folder, 'old/missing-title.md'))).toBe(true);
    expect(await owner.transaction('snapshot', async (tx) => (await tx.query('SELECT * FROM operation')).rows)).toEqual([]);
  } finally { await owner.close(); }
}, 15000);

test('an archive link is refused without losing the committed source or writing outside', async () => {
  const folder = fixture();
  const parsed = readKinds(folder);
  if (!parsed.present) throw new Error('fixture manifest missing');
  writeFileSync(join(folder, 'old/kept.md'), '---\nid: note:kept\nkind: note\ntitle: Kept\n---\nBody');
  const outside = mkdtempSync(join(root, 'outside-'));
  symlinkSync(outside, join(folder, '.madarch'));
  const owner = await createTestDatabaseOwner({ graphContract: graphContractOf(parsed.manifest) });
  try {
    await createOneGraphSchema(owner, graphContractOf(parsed.manifest));
    const result = await importAuthored(folder, owner, parsed.manifest, '', 'reader');
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
  const owner = await createTestDatabaseOwner({ graphContract: graphContractOf(parsed.manifest) });
  try {
    await createOneGraphSchema(owner, graphContractOf(parsed.manifest));
    expect(await authoredHistoryPresent(owner)).toBe(false);
    const created = await owner.transaction('write', async (tx) =>
      await authoredEntity(tx, parsed.manifest, '', 'person:reader', 'create', 'note', { values: { title: 'Kept' } }));
    expect(await authoredHistoryPresent(owner)).toBe(true);
    await owner.transaction('write', async (tx) =>
      await authoredEntity(tx, parsed.manifest, '', 'person:reader', 'delete', 'note', { uid: created.entity!.uid }));
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
  const owner = await createTestDatabaseOwner({ graphContract: graphContractOf(parsed.manifest) });
  try {
    await createOneGraphSchema(owner, graphContractOf(parsed.manifest));
    const first = await importAuthored(folder, owner, parsed.manifest, '', 'first-reader');
    expect(first.imported).toEqual(['old/kept.md']);
    expect(first.archived).toEqual([]);
    const uid = await owner.transaction('snapshot', async (tx) => (await tx.query<{ uid: string }>('SELECT uid::text AS uid FROM node')).rows[0]!.uid);
    writeFileSync(join(folder, 'old/kept.md'), changed);
    rmSync(join(folder, '.madarch'));
    const retry = await importAuthored(folder, owner, parsed.manifest, '', 'second-reader');
    expect(retry.errors).toEqual([]);
    expect(retry.imported).toEqual(['old/kept.md']);
    expect(retry.archived).toEqual(['old/kept.md']);
    const nodes = await owner.transaction('snapshot', async (tx) => (await tx.query<{ uid: string }>('SELECT uid::text AS uid FROM node')).rows);
    expect(nodes).toEqual([{ uid }]);
    const held = await owner.transaction('snapshot', async (tx) => await authoredEntity(tx, parsed.manifest, '', 'second-reader', 'read', 'note', { uid }));
    expect(held.entity!.opinions).toHaveLength(2);
    expect(held.entity!.opinions.map((opinion) => opinion['said_by']).sort()).toEqual(['first-reader@1', 'second-reader@1']);
    const receipts = await owner.transaction('snapshot', async (tx) => (await tx.query<{ words: string }>('SELECT words FROM operation ORDER BY seq')).rows.map((row) => JSON.parse(row.words)));
    expect(receipts.map((receipt) => Buffer.from(receipt.bytes, 'base64'))).toEqual([original, changed]);
    expect(receipts.map((receipt) => [receipt.path, receipt.legacyId])).toEqual([['old/kept.md', 'note:kept'], ['old/kept.md', 'note:kept']]);
    // A second interrupted retry of the changed bytes must not publish them twice.
    writeFileSync(join(folder, 'old/kept.md'), changed);
    expect((await importAuthored(folder, owner, parsed.manifest, '', 'second-reader')).imported).toEqual([]);
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
  const owner = await createTestDatabaseOwner({ graphContract: graphContractOf(parsed.manifest) });
  try {
    await createOneGraphSchema(owner, graphContractOf(parsed.manifest));
    await importAuthored(folder, owner, parsed.manifest, '', 'reader');
    writeFileSync(join(folder, 'old/kept.md'), changed);
    const retry = await importAuthored(folder, owner, parsed.manifest, '', 'reader');
    expect(retry.imported).toEqual(['old/kept.md']);
    const receipts = await owner.transaction('snapshot', async (tx) => (await tx.query<{ words: string }>('SELECT words FROM operation ORDER BY seq')).rows.map((row) => JSON.parse(row.words)));
    expect(receipts.map((receipt) => Buffer.from(receipt.bytes, 'base64'))).toEqual([original, changed]);
    expect((await importAuthored(folder, owner, parsed.manifest, '', 'reader')).imported).toEqual([]);
    const held = await owner.transaction('snapshot', async (tx) => await authoredEntity(tx, parsed.manifest, '', 'reader', 'list', 'note'));
    expect(held.entities).toHaveLength(1);
    expect(held.entities![0]!.opinions).toHaveLength(1);
  } finally { await owner.close(); }
}, 15000);
