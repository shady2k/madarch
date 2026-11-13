import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
/**
 * The Problems page answers in levels (madarch-8bdc.2.5): one row per rule, the sources of a rule, and the items of a
 * source, each a bounded page the server builds. This fixture holds more than one page of sources, so the test walks
 * every page and counts them: the sum equals the category, the category sums equal the status's open count, and no
 * status or glossary answer carries the findings themselves.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { commitProduct, makeProduct, SAMPLE_IDENTITY, withRepositoryPluginsOnly } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';
import { fillInProcess } from './fill-inline.js';
import { restrictRepositoryDeclarations } from './repository-contract-fixture.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { parse, stringify } from 'yaml';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const EMPTY_REPOSITORIES = 120;

let work: string;
let home: string;
let folder: string;
let server: StartedServer;

const get = async (path: string): Promise<{ status: number; body: any; bytes: number }> => {
  const response = await fetch(`${server.url}/products/shop${path}`);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), bytes: Buffer.byteLength(text) };
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-problems-pages-'));
  home = join(work, 'home');
  const repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repository, 'README.md'), '# A repository\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '--quiet', '-m', 'First');
  folder = makeProduct(home, 'shop', repository);
  withRepositoryPluginsOnly(folder);
  // A declared, present repository with no commit is a native graph-context finding, not a retired Markdown read.
  const workspace = join(folder, 'workspace.yaml');
  let workspaceText = readFileSync(workspace, 'utf8');
  for (let i = 0; i < EMPTY_REPOSITORIES; i += 1) {
    const name = `empty-${String(i).padStart(3, '0')}`;
    const empty = join(folder, 'repos', name);
    mkdirSync(empty);
    git(empty, 'init', '--quiet', '--initial-branch=main');
    workspaceText = manifestWithRepo(workspaceText, { name, linked: true });
  }
  writeFileSync(workspace, workspaceText);
  // Pagination needs repository facts and one rule, not the starter catalogue's hundreds of planned kinds.
  restrictRepositoryDeclarations(folder);
  const starter = parse(readFolderManifestText(folder));
  starter.problems = { rules: { 'wiki.unreadable-file': starter.problems.rules['wiki.unreadable-file'] } };
  writeFolderManifest(folder, stringify(starter));
  commitProduct(folder, 'Declare empty repositories for paged problems');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  // The Problems page reads the graph: one pass of the files producer in this process stores the product repository.
  await fillInProcess(folder, home, join(work, 'store'));
  await get('/api/status');
}, 300_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the Problems page in levels', () => {
  test('the categories count every rule, and the status count is their open sum', async () => {
    const categories = await get('/api/problems');
    expect(categories.status, JSON.stringify(categories.body)).toBe(200);
    expect(categories.body.categories.some((category: { rule: string }) => category.rule === 'wiki.unreadable-file')).toBe(true);
    const unreadable = categories.body.categories.find((category: { rule: string }) => category.rule === 'wiki.unreadable-file');
    expect(unreadable.count).toBeGreaterThanOrEqual(EMPTY_REPOSITORIES);
    const openSum = categories.body.categories.reduce((sum: number, category: { open: number }) => sum + category.open, 0);
    // The listing is collected beside the first status answer; its next poll carries the count of exactly these inputs.
    let problemsOpen: number | undefined;
    for (let i = 0; i < 200 && typeof problemsOpen !== 'number'; i += 1) {
      if (i > 0) await new Promise((rest) => setTimeout(rest, 10));
      const status = await get('/api/status');
      expect(status.status).toBe(200);
      problemsOpen = status.body.loop.problemsOpen;
    }
    expect(problemsOpen).toBe(openSum);
    const settled = await get('/api/status');
    expect(settled.body.findingCount).toBe(categories.body.total);
  }, 60_000);

  test('the sources of a category are pages, and walking every page counts the category', async () => {
    const categories = (await get('/api/problems')).body;
    const category = categories.categories.find((one: { rule: string }) => one.rule === 'wiki.unreadable-file');
    let after: string | undefined;
    let pages = 0;
    let sources = 0;
    let items = 0;
    for (;;) {
      const path = `/api/problems?rule=${encodeURIComponent('wiki.unreadable-file')}${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`;
      const page = await get(path);
      expect(page.status).toBe(200);
      expect(page.body.sources.length).toBeLessThanOrEqual(100);
      pages += 1;
      for (const source of page.body.sources) {
        sources += source.count;
        let cursor: string | undefined;
        for (;;) {
          const itemsPath = `/api/problems?rule=${encodeURIComponent('wiki.unreadable-file')}&source=${encodeURIComponent(source.key)}${cursor === undefined ? '' : `&after=${encodeURIComponent(cursor)}`}`;
          const listed = await get(itemsPath);
          expect(listed.status).toBe(200);
          expect(listed.body.problems.length).toBeLessThanOrEqual(100);
          items += listed.body.problems.length;
          if (listed.body.next === null) break;
          cursor = listed.body.next;
        }
      }
      if (page.body.next === null) break;
      after = page.body.next;
    }
    expect(pages).toBeGreaterThan(1);
    expect(sources).toBe(category.count);
    expect(items).toBe(category.count);
  }, 60_000);

  test('status and glossary carry a count, never the findings, and stay small', async () => {
    const status = await get('/api/status');
    expect(status.status).toBe(200);
    expect(Object.hasOwn(status.body, 'findings')).toBe(false);
    expect(typeof status.body.findingCount).toBe('number');
    expect(status.bytes).toBeLessThan(200_000);
    const glossary = await get('/api/glossary');
    expect(glossary.status).toBe(200);
    expect(Object.hasOwn(glossary.body, 'findings')).toBe(false);
    expect(typeof glossary.body.findingCount).toBe('number');
    expect(glossary.bytes).toBeLessThan(200_000);
  }, 60_000);

  test('a page bound beyond 100 is refused, with the accepted range', async () => {
    const refused = await get('/api/problems?limit=101');
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('1 to 100');
  });
});
