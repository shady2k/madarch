/**
 * The page budget on a repository of the walk's size class (review of madarch-8bdc.2.17): a page's statements and
 * rows are read from its own trace transaction, so a regression to a per-row read fails here.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFill } from '../src/fill/run.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { makeProduct, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
let root = '';
let home = '';
let app = '';
let folder = '';
let repository = '';
let server: StartedServer | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-page-budget-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  repository = join(root, 'big');
  mkdirSync(join(repository, 'src'), { recursive: true });
  for (let at = 0; at < 1_800; at += 1) writeFileSync(join(repository, 'src', `file-${String(at).padStart(4, '0')}.ts`), `export const n = ${String(at)};\n`);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'one thousand eight hundred files');
  folder = makeProduct(home, 'shop', repository, 'big');
  const store = productStoreFolder(folder, knowledgeRootOf(home));
  mkdirSync(join(store, 'graph'), { recursive: true });
  const owner = await createTestDatabaseOwner({ store: join(store, 'graph'), btreeGist: true });
  try {
    const run = await runFill({ product: folder, database: owner, store, home: store, runId: 'page-budget' });
    expect(run.ok).toBe(true);
  } finally {
    await owner.close();
  }
  server = await startServer({ productHome: home, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

async function pageStats(path: string): Promise<{ statements: number; rows: number; elapsed: number; evidence: number }> {
  const file = join(knowledgeRootOf(home), 'traces', `server-${String(process.pid)}.jsonl`);
  const before = (() => { try { return readFileSync(file, 'utf8').split('\n').length; } catch { return 0; } })();
  const at = Date.now();
  const answer = await fetch(`${server!.url}${path}`, { headers: { accept: 'application/json' } });
  expect(answer.status).toBe(200);
  const elapsed = Date.now() - at;
  await Bun.sleep(100);
  const lines = readFileSync(file, 'utf8').split('\n').slice(before - 1).filter(Boolean);
  let statements = 0;
  let rows = 0;
  let evidence = 0;
  for (const line of lines) {
    const span = JSON.parse(line) as { name: string; attributes?: { key: string; value: { intValue?: string } }[] };
    if (span.name === 'wiki.history.evidence') evidence += 1;
    if (span.name !== 'db.transaction') continue;
    const attrs = new Map((span.attributes ?? []).map((one) => [one.key, one.value.intValue]));
    statements += Number(attrs.get('db.statements') ?? '0');
    rows += Number(attrs.get('db.rows') ?? '0');
  }
  return { statements, rows, elapsed, evidence };
}

test('the four entity pages of a walk-size repository stay bounded, cold with no history cache', async () => {
  const hash = git(repository, 'rev-parse', 'HEAD');
  const email = git(repository, 'log', '-1', '--format=%ae');
  const pages = [
    // The repository page is the Files page (madarch-j9ao.1): its map and table read the repository's files and their
    // rhythm, one page of files and one aggregate of commits each — 2 000 rows apiece on this repository, and never the
    // whole history evidence.
    ['repository', `/products/shop/api/page?id=${encodeURIComponent('code.repository:big')}&full=1`, 90, 24_000, 300],
    ['commit', `/products/shop/api/page?id=${encodeURIComponent(`code.commit:${hash}`)}&full=1`, 55, 10_000, 200],
    ['file', `/products/shop/api/page?id=${encodeURIComponent('code.file:big/src/file-0000.ts')}&full=1`, 30, 17_000, 200],
    ['author', `/products/shop/api/page?id=${encodeURIComponent(`code.author:${email}`)}&full=1`, 20, 10_000, 200],
  ] as const;
  for (const [name, path, maxStatements, maxRows, maxMs] of pages) {
    const held = await pageStats(path);
    expect({ name, statements: held.statements }).toEqual({ name, statements: expect.any(Number) });
    expect(held.statements, name).toBeLessThan(maxStatements);
    expect(held.rows, name).toBeLessThan(maxRows);
    expect(held.elapsed, name).toBeLessThan(maxMs);
    if (name === 'repository' || name === 'commit') expect(held.evidence, `${name} reads no whole history evidence`).toBe(0);
  }
}, 120_000);
