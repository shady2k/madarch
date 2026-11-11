import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds } from '../src/knowledge/kinds.js';
import { importAuthored, AUTHORED_ARCHIVE } from '../src/knowledge/import-authored.js';
import { readMarkdownEntitiesFrom } from '../src/knowledge/markdown.js';
import { workingTreeFiles } from '../src/knowledge/product-files.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { createTestDatabaseOwner } from './test-database.js';

const root = mkdtempSync(join(tmpdir(), 'authored-import-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'));
  mkdirSync(join(folder, 'templates'));
  mkdirSync(join(folder, 'old'));
  writeFileSync(join(folder, 'templates/page.liquid'), '');
  writeFileSync(join(folder, 'madarch/kinds.yaml'), `kinds:
  note:
    source: graph
    origin: person
    template: templates/page.liquid
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
  const owner = await createTestDatabaseOwner();
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
    expect(readMarkdownEntitiesFrom(workingTreeFiles(folder), oldManifest)).toEqual({ entities: [], findings: [] });
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
  const owner = await createTestDatabaseOwner();
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
  const owner = await createTestDatabaseOwner();
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
