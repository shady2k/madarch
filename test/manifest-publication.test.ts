import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabaseOwner } from './test-database.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { EMPTY_CONTRACT, generatedTableName } from '../src/graph/contract.js';
import { validateProductManifests, publishValidatedManifests, readPublishedManifest } from '../src/graph/manifest-publication.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { createManifestWatch } from '../src/product/manifest-watch.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-publication-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'));
  mkdirSync(join(folder, 'templates'));
  writeFileSync(join(folder, 'templates', 'term.md'), '# Term');
  writeFolderManifest(folder, `kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
`);
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  future: { status: planned, stages: [] }\n');
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  return folder;
}

test('publishes complete metadata and declaration evidence without repository content or fill', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const read = validateProductManifests(folder);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(JSON.stringify(read.findings));
    if (read.value === undefined) throw new Error('fixture manifest was absent');
    expect(await publishValidatedManifests(owner, read.value)).toBeGreaterThan(0);
    const manifest = await owner.run((tx) => readPublishedManifest(tx));
    expect([...manifest!.kinds.keys()]).toEqual(['term']);
    expect([...manifest!.workflows!.workflows.keys()]).toEqual(['future']);
    const rows = await owner.run((tx) => tx.query<{ evidence: { path: string; line_start: number; commit_or_digest: string }[] }>(`SELECT evidence FROM "${generatedTableName('manifest.kind', 'vertex')}" WHERE state = 'open'`));
    expect(rows.rows[0]!.evidence[0]!.path).toBe('madarch/kinds/fixture/fixture/term.yaml');
    expect(rows.rows[0]!.evidence[0]!.line_start).toBe(1);
    expect(rows.rows[0]!.evidence[0]!.commit_or_digest).toHaveLength(40);
    let queries = 0;
    const counted = { ...owner, transaction: async <T>(kind: Parameters<typeof owner.transaction>[0], work: Parameters<typeof owner.transaction<T>>[1]): Promise<T> => owner.transaction(kind, async (tx) => work({ ...tx, query: async (...args: Parameters<typeof tx.query>) => { queries++; return tx.query(...args); } } as typeof tx)) };
    expect(await publishValidatedManifests(counted, read.value)).toBe(0);
    expect(queries).toBeLessThan(10);
    const regrounded = { ...read.value, vertices: read.value.vertices.map((one) => ({ ...one, evidence: [{ repository: folder, path: 'madarch/catalog.yaml', lineStart: 9, lineEnd: 9, commit: 'b'.repeat(40) }] })) };
    expect(await publishValidatedManifests(owner, regrounded)).toBeGreaterThan(0);
    const grounds = await owner.run((tx) => tx.query<{ evidence: { line_start: number; commit_or_digest: string }[] }>(`SELECT evidence FROM "${generatedTableName('manifest.kind', 'vertex')}" WHERE state = 'open'`));
    expect(grounds.rows[0]!.evidence[0]!.line_start).toBe(9);
    expect(grounds.rows[0]!.evidence[0]!.commit_or_digest).toBe('b'.repeat(40));
    expect(await publishValidatedManifests(owner, regrounded)).toBe(0);
    const edited = { ...regrounded, vertices: regrounded.vertices.map((one) => one.kind === 'manifest.kind' ? { ...one, values: { declaration: { changed: true } } } : one) };
    expect(await publishValidatedManifests(owner, edited)).toBeGreaterThan(0);
    const declaration = await owner.run((tx) => tx.query<{ declaration: unknown }>(`SELECT declaration FROM "${generatedTableName('manifest.kind', 'vertex')}" WHERE state = 'open'`));
    expect(declaration.rows[0]!.declaration).toEqual({ changed: true });
    expect(await publishValidatedManifests(owner, edited)).toBe(0);
    // An older matching opinion is closed history, not proof that the latest declaration is unchanged.
    expect(await publishValidatedManifests(owner, regrounded)).toBeGreaterThan(0);
    expect(await publishValidatedManifests(owner, regrounded)).toBe(0);
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.size).toBe(1);
    const contents = await owner.run((tx) => tx.query<{ count: string }>("SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name LIKE 'code.%'"));
    expect(contents.rows[0]!.count).toBe('0');
  } finally { await owner.close(); }
}, 30_000);

test('reports all invalid declarations with full paths and retains the last valid publication on refresh', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  const watch = createManifestWatch([], async (value) => { await publishValidatedManifests(owner, value); }, (line) => reports.push(line));
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    await watch.refresh(folder);
    writeFolderManifest(folder, 'kinds:\n  bad: { source: unknown, template: missing.md }\n');
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  broken: { status: wrong, stages: [unknown] }\n');
    const read = validateProductManifests(folder);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('invalid manifests accepted');
    expect(read.findings.some((one) => one.file === join(folder, 'madarch/kinds/fixture/fixture/bad.yaml'))).toBe(true);
    expect(read.findings.some((one) => one.file === join(folder, 'madarch', 'workflows.yaml'))).toBe(true);
    expect(read.findings.every((one) => one.line > 0)).toBe(true);
    await watch.refresh(folder);
    expect(reports.length).toBeGreaterThan(1);
    expect([...((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.keys())]).toEqual(['term']);
    writeFolderManifest(folder, 'kinds: {}\n');
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    await watch.refresh(folder);
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.size).toBe(0);
    const rows = await owner.run((tx) => tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${generatedTableName('manifest.kind', 'vertex')}" WHERE state = 'open'`));
    expect(rows.rows[0]!.count).toBe('0');
  } finally { watch.stop(); await owner.close(); }
}, 30_000);

test('filesystem watcher publishes a valid edit and refuses invalid edits without losing metadata', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  let publications = 0;
  let resolvePublished: (() => void) | undefined;
  let resolveRefused: (() => void) | undefined;
  const watcher = createManifestWatch([folder], async (value) => {
    await publishValidatedManifests(owner, value);
    publications++;
    resolvePublished?.();
  }, (line) => { reports.push(line); resolveRefused?.(); });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    await watcher.refresh(folder);
    const published = new Promise<void>((done) => { resolvePublished = done; });
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  later: { status: planned, stages: [] }\n');
    await published;
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.workflows!.workflows.has('later')).toBe(true);
    resolvePublished = undefined;
    const refused = new Promise<void>((done) => { resolveRefused = done; });
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  invalid: { status: incorrect }\n');
    await refused;
    expect(reports.some((line) => line.includes('workflows.yaml:2:'))).toBe(true);
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.workflows!.workflows.has('later')).toBe(true);
    expect(publications).toBeGreaterThan(1);
  } finally { watcher.stop(); await owner.close(); }
}, 30_000);

test('a home watcher discovers the current folder when the startup folder has already moved', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: startup-fixture\nname: fixture\n');
  const moved = join(root, 'startup-renamed');
  renameSync(folder, moved);
  const publications: string[] = [];
  const watcher = createManifestWatch([folder], async (value) => { publications.push(value.folder); }, () => {}, root);
  try {
    for (let tries = 0; tries < 200 && !publications.includes(moved); tries++) await Bun.sleep(25);
    expect(publications, `${moved}:1: the startup rename was not published`).toContain(moved);
    writeFileSync(join(moved, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    const before = publications.length;
    for (let tries = 0; tries < 200 && publications.length === before; tries++) await Bun.sleep(25);
    expect(publications.length, `${moved}:1: the startup rename was not watched`).toBeGreaterThan(before);
  } finally { watcher.stop(); }
}, 15_000);

test('a home watcher follows a renamed product and keeps its watch while its identity needs repair', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: fixture\n');
  const moved = join(root, 'renamed');
  const publications: string[] = [];
  const reports: string[] = [];
  const watcher = createManifestWatch([folder], async (value) => { publications.push(value.folder); }, (line) => reports.push(line), root);
  const until = async (ready: () => boolean): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      if (ready()) return;
      await Bun.sleep(25);
    }
    throw new Error(`${moved}:1: watcher did not settle: ${reports.join('; ')}`);
  };
  try {
    renameSync(folder, moved);
    await until(() => publications.includes(moved));
    writeFileSync(join(moved, 'workspace.yaml'), 'schemaVersion: 1\nid: [invalid\n');
    // A change to the home asks discovery to read the broken identity.
    const signal = join(root, 'signal'); mkdirSync(signal);
    await until(() => reports.some((line) => line.includes(`${moved}/workspace.yaml:2:`)));
    const before = publications.length;
    writeFileSync(join(moved, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: repaired\n');
    writeFileSync(join(moved, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    await until(() => publications.length > before);
    expect(publications.slice(before)).toContain(moved);
    expect(reports.some((line) => line.includes(`${moved}/workspace.yaml:2:`))).toBe(true);
  } finally { watcher.stop(); }
}, 15_000);

test('malformed kinds still reports workflow and lock diagnostics, and no commit is refused', () => {
  const folder = fixture();
  writeFileSync(join(folder, 'madarch/catalog.yaml'), 'groups: [');
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: [');
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), 'plugins: [');
  const invalid = validateProductManifests(folder);
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid manifests accepted');
  for (const name of ['catalog.yaml', 'workflows.yaml', 'plugins.lock']) expect(invalid.findings.some((one) => one.file === join(folder, 'madarch', name))).toBe(true);
  const fresh = fixture();
  rmSync(join(fresh, '.git'), { recursive: true });
  const noCommit = validateProductManifests(fresh);
  expect(noCommit.ok).toBe(false);
  if (noCommit.ok) throw new Error('no commit accepted');
  expect(noCommit.findings[0]!.file).toBe(join(fresh, '.git', 'HEAD'));
});

test('an absent kinds manifest is valid without publishing a catalogue, but invalid declarations still refuse', () => {
  const folder = fixture();
  rmSync(join(folder, 'madarch', 'catalog.yaml'));
  rmSync(join(folder, 'madarch/kinds'), { recursive: true, force: true });
  expect(validateProductManifests(folder)).toEqual({ ok: true, value: undefined });
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: [');
  const invalid = validateProductManifests(folder);
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid workflow accepted without kinds');
  expect(invalid.findings.some((one) => one.file === join(folder, 'madarch', 'workflows.yaml'))).toBe(true);
});

test('named plugin manifests use the existing plugin validator for missing and malformed files', () => {
  const folder = fixture();
  mkdirSync(join(folder, 'plugins', 'words'), { recursive: true });
  writeFolderManifest(folder, `plugins:
  - id: words
    version: "1"
    path: plugins/words
    inputs: [term]
    outputs: [term]
    closure: [main.ts]
kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
`);
  const file = join(folder, 'plugins', 'words', 'plugin.json');
  const missing = validateProductManifests(folder);
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error('missing plugin accepted');
  expect(missing.findings.some((one) => one.file === file)).toBe(true);
  writeFileSync(file, '{ "name": 7 }');
  const malformed = validateProductManifests(folder);
  expect(malformed.ok).toBe(false);
  if (malformed.ok) throw new Error('malformed plugin accepted');
  expect(malformed.findings.some((one) => one.file === file && one.line === 1 && one.message.length > 0)).toBe(true);
});

test('the published declarations answer before any fill, even after the checkout changes', async () => {
  const folder = fixture();
  writeFolderManifest(folder, `properties:
  summary: { en: Summary, ru: Описание }
kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
    details: [summary]
    fields:
      - { name: summary, type: text, producers: [reader] }
`);
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    writeFolderManifest(folder, 'kinds: {}');
    const manifest = (await owner.run((tx) => readPublishedManifest(tx)))!;
    // The graph's published manifest is the one that answers: the checkout's later edit changes nothing.
    expect([...manifest.kinds.keys()]).toEqual(['term']);
    expect(manifest.kinds.get('term')?.fields?.map((field) => field.name)).toEqual(['summary']);
    expect(graphqlSchemaOf(publishedManifestOf(manifest))).toContain('type Term implements Entity');
    const contents = await owner.run((tx) => tx.query<{ count: string }>("SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'code.file'"));
    expect(contents.rows[0]!.count).toBe('0');
  } finally { await owner.close(); }
}, 30_000);

test('purpose labels and order publish through the manifest watcher without a fill', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  const watch = createManifestWatch([], async (value) => { await publishValidatedManifests(owner, value); }, (line) => reports.push(line));
  const declaration = (label: string, order: number) => `purposes:
  understand: { labels: { en: ${label}, ru: Понять }, order: ${order} }
kinds:
  term:
    purpose: understand
    source: document
    
    terms: ["docs/*.md"]
`;
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    writeFolderManifest(folder, declaration('Understand', 10));
    await watch.refresh(folder);
    let published = await owner.run((tx) => readPublishedManifest(tx));
    expect(published?.kinds.get('term')?.purpose).toBe('understand');
    expect(published?.purposes?.get('understand')?.labels.en).toBe('Understand');
    writeFolderManifest(folder, declaration('Read first', 50));
    await watch.refresh(folder);
    published = await owner.run((tx) => readPublishedManifest(tx));
    expect(published?.purposes?.get('understand')?.labels.en).toBe('Read first');
    expect(published?.purposes?.get('understand')?.order).toBe(50);
    expect(reports).toEqual([]);
  } finally { watch.stop(); await owner.close(); }

}, 30_000);
