/**
 * The tree and history passes publish the mechanism entries always and only the entities the product's manifest
 * declares (madarch-hsqs stage C): a manifest declaring code.file and not code.repository fills, and one declaring
 * code.repository and not code.file fills, each with no table and no row for the kind it does not declare.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { fillInProcess } from './fill-inline.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';
import { publishFixtureTemplate } from './structured-template-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';
let server: StartedServer | undefined;
const errors: string[] = [];

/** A native fixture declaring only the named code kinds and references within that set. */
function draftWithKinds(name: string, kinds: readonly string[]): string {
  const draft = createDraft({ home, name, gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(`the fixture product was not made: ${JSON.stringify(draft)}`);
  const file = join(draft.folder, 'madarch', 'kinds.yaml');
  const manifest = parse(readFileSync(file, 'utf8')) as { kinds: Record<string, { fields?: { reference?: string }[]; 'depends-on'?: string[] }>; plugins: unknown };
  const declared = [...kinds, 'template'];
  for (const kind of Object.keys(manifest.kinds)) if (!declared.includes(kind)) delete manifest.kinds[kind];
  for (const kind of Object.values(manifest.kinds)) {
    if (kind['depends-on'] !== undefined) kind['depends-on'] = kind['depends-on'].filter((dependency) => declared.includes(dependency));
    if (kind.fields !== undefined) for (const field of kind.fields) {
      if (field.reference !== undefined && !declared.includes(field.reference)) delete field.reference;
    }
  }
  manifest.plugins = [];
  writeFileSync(file, stringify(manifest));
  writeFileSync(join(draft.folder, 'madarch', 'workflows.yaml'), `workflows:
  first-fill:
    status: implemented
    stages: [repository-tree, repository-history]
`);
  git(draft.folder, 'add', '-A');
  git(draft.folder, 'commit', '-qm', `the manifest declares ${kinds.join(', ')} and no other code kind`);
  return draft.folder;
}

async function publishPageTemplate(product: string, path: string): Promise<void> {
  const store = productStoreFolder(product, knowledgeRootOf(home));
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store) });
  try {
    await publishFixtureTemplate(owner, product, path);
  } finally {
    await owner.close();
  }
}

async function tables(store: string): Promise<string[]> {
  const owner: DatabaseOwner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    const found = await owner.run((tx) => tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    ));
    return found.rows.map((row) => row.table_name);
  } finally {
    await owner.close().catch(() => undefined);
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-declared-entities-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  draftWithKinds('files-only', ['code.file']);
  draftWithKinds('repos-only', ['code.repository']);
  server = await startPreparedServer({ productHome: home, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: (line) => errors.push(line) });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('a manifest declares one code kind and not the other', () => {
  test('code.file without code.repository fills: files are published, no repository table stands', async () => {
    const product = join(home, 'files-only');
    await fillInProcess(product, home);
    await publishPageTemplate(product, 'templates/file.liquid');
    const status = await (await fetch(`${server!.url}/products/files-only/api/status`, { headers: { accept: 'application/json' } })).json() as { filled: boolean; kinds: { kind: string; count: number }[] };
    expect(status.filled, JSON.stringify({ status, errors })).toBe(true);
    expect(status.kinds.find((kind) => kind.kind === 'code.file')?.count).toBeGreaterThan(0);
    expect(status.kinds.some((kind) => kind.kind === 'code.repository')).toBe(false);
    const names = await tables(productStoreFolder(product, knowledgeRootOf(home)));
    expect(names.some((name) => name.startsWith('k_file_'))).toBe(true);
    expect(names.some((name) => name.startsWith('k_repository_'))).toBe(false);
    // Its pages: the declared file kind's listing and a file's page answer, and no statement names a table the manifest
    // did not make (madarch-hsqs stage C: the declared contract, not a caught 42P01).
    // A file the fill read, by its entity id; the listing itself is the tree's (`code.contains`), which this manifest
    // does not declare, so the direct page is what proves the file page renders from the one declared kind.
    const page = await fetch(`${server!.url}/products/files-only/api/page?id=${encodeURIComponent('code.file:files-only/madarch/kinds.yaml')}&full=1`, { headers: { accept: 'application/json' } });
    expect(page.status).toBe(200);
    for (const path of ['/api/status', '/api/catalog', '/api/glossary', '/api/documents']) {
      expect((await fetch(`${server!.url}/products/files-only${path}`, { headers: { accept: 'application/json' } })).status, path).toBe(200);
    }
    expect(errors.filter((line) => /does not exist|42P01/i.test(line))).toEqual([]);
  }, 60_000);

  test('code.repository without code.file fills: the repository is published, no file table stands', async () => {
    const product = join(home, 'repos-only');
    await fillInProcess(product, home);
    await publishPageTemplate(product, 'templates/repository.liquid');
    const status = await (await fetch(`${server!.url}/products/repos-only/api/status`, { headers: { accept: 'application/json' } })).json() as { filled: boolean; kinds: { kind: string; count: number }[] };
    expect(status.filled).toBe(true);
    expect(status.kinds.find((kind) => kind.kind === 'code.repository')?.count).toBe(1);
    expect(status.kinds.some((kind) => kind.kind === 'code.file')).toBe(false);
    const names = await tables(productStoreFolder(product, knowledgeRootOf(home)));
    expect(names.some((name) => name.startsWith('k_repository_'))).toBe(true);
    expect(names.some((name) => name.startsWith('k_file_'))).toBe(false);
    // The repository page renders from the one declared kind, and nothing names a file or commit table.
    const page = await fetch(`${server!.url}/products/repos-only/api/page?id=${encodeURIComponent('code.repository:repos-only')}&full=1`, { headers: { accept: 'application/json' } });
    expect(page.status, JSON.stringify({ body: await page.text(), errors })).toBe(200);
    expect(errors.filter((line) => /does not exist|42P01/i.test(line))).toEqual([]);
  }, 60_000);
});
