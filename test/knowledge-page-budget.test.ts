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
import { finishKnowledgeStore } from '../src/knowledge/fill-run.js';
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
let historyFolder = '';
let historyRepository = '';
let server: StartedServer | undefined;

/** A repository of a few thousand commits, written by one `git fast-import` stream: one small file changes every commit. */
function fewThousandCommits(folder: string, count: number): string {
  git(folder, 'init', '-q', '-b', 'main');
  const lines: string[] = [];
  for (let at = 1; at <= count; at += 1) {
    const stamp = 1_700_000_000 + at * 60;
    const message = `commit ${String(at)}\n`;
    const content = `line ${String(at)}\n`;
    lines.push('commit refs/heads/main');
    lines.push(`mark :${String(at)}`);
    lines.push(`author A <a@example.test> ${String(stamp)} +0000`);
    lines.push(`committer A <a@example.test> ${String(stamp)} +0000`);
    lines.push(`data ${String(Buffer.byteLength(message))}`);
    lines.push(message.trimEnd());
    if (at > 1) lines.push(`from :${String(at - 1)}`);
    lines.push('M 100644 inline src/history.txt');
    lines.push(`data ${String(Buffer.byteLength(content))}`);
    lines.push(content.trimEnd());
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: folder, env, input: `${lines.join('\n')}\n` });
  git(folder, 'checkout', '-f', 'main');
  return git(folder, 'rev-list', '--count', 'HEAD');
}

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
  historyRepository = join(root, 'history-big');
  mkdirSync(historyRepository, { recursive: true });
  expect(fewThousandCommits(historyRepository, 2_500)).toBe('2500');
  historyFolder = makeProduct(home, 'history-shop', historyRepository, 'big');
  for (const product of [folder, historyFolder]) {
    const store = productStoreFolder(product, knowledgeRootOf(home));
    mkdirSync(join(store, 'graph'), { recursive: true });
    const owner = await createTestDatabaseOwner({ store: join(store, 'graph'), btreeGist: true });
    try {
      const run = await runFill({ product, database: owner, store, home: store, runId: `page-budget-${product === folder ? 'shop' : 'history'}` });
      expect(run.ok).toBe(true);
      // What every settled fill does (the button, the CLI, the daemon): the store's statistics and pins.
      await finishKnowledgeStore(owner);
    } finally {
      await owner.close();
    }
  }
  server = await startServer({ productHome: home, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 300_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

async function pageStats(path: string): Promise<{ statements: number; rows: number; elapsed: number; evidence: number; historyMs: number }> {
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
  let historyMs = 0;
  for (const line of lines) {
    const span = JSON.parse(line) as { name: string; startTimeUnixNano?: string; endTimeUnixNano?: string; attributes?: { key: string; value: { intValue?: string } }[] };
    if (span.name === 'wiki.history.evidence') evidence += 1;
    if (span.name === 'wiki.block.history' && span.startTimeUnixNano !== undefined && span.endTimeUnixNano !== undefined) {
      historyMs = Math.max(historyMs, (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6);
    }
    if (span.name !== 'db.transaction') continue;
    const attrs = new Map((span.attributes ?? []).map((one) => [one.key, one.value.intValue]));
    statements += Number(attrs.get('db.statements') ?? '0');
    rows += Number(attrs.get('db.rows') ?? '0');
  }
  return { statements, rows, elapsed, evidence, historyMs };
}

test('the four entity pages of a walk-size repository stay bounded, cold with no history cache', async () => {
  const hash = git(repository, 'rev-parse', 'HEAD');
  const email = git(repository, 'log', '-1', '--format=%ae');
  const pages = [
    // Stage C stores the product repository in the graph too, so the first request's reader open reads the as-is commit
    // of both repositories: measured on this box 17 341 rows (main without the product repository entity: 15 407),
    // the page's own transaction 13 593 of them. The bound names that graph, not a smaller page.
    ['repository', `/products/shop/api/page?id=${encodeURIComponent('code.repository:big')}&full=1`, 90, 18_000, 300],
    ['commit', `/products/shop/api/page?id=${encodeURIComponent(`code.commit:${hash}`)}&full=1`, 55, 10_000, 200],
    // The file page costs 30 statements on this box at 0cc3fc1a and at this commit (measured: the page is one plan
    // short of the bound the earlier machine named); the bound names the statement the page holds, not a smaller page.
    ['file', `/products/shop/api/page?id=${encodeURIComponent('code.file:big/src/file-0000.ts')}&full=1`, 31, 17_000, 200],
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

test('a repository of a few thousand commits keeps the page and its history block bounded', async () => {
  const path = `/products/history-shop/api/page?id=${encodeURIComponent('code.repository:big')}&full=1`;
  // The first read opens the store's buffers; the measurement is the page a reader meets after that.
  await pageStats(path);
  const held = await pageStats(path);
  expect({ name: 'history', statements: held.statements }).toEqual({ name: 'history', statements: expect.any(Number) });
  expect(held.elapsed, 'history').toBeLessThan(300);
  expect(held.historyMs, 'history block').toBeLessThan(100);
}, 120_000);
