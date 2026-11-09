/**
 * A count is collected once per revision of the inputs the Problems page reads (madarch-m38l.19). The menu's count and
 * the badge of a page used to collect the listing for themselves, so eight status polls at once during a fill walked the
 * graph eight times and each page walked it again; on the pod that held the store long enough for a poll to answer in
 * 442 ms instead of under 300 ms.
 *
 * The counter wraps the one function that walks the graph, `collectProblems`, so the test counts the walks themselves,
 * not the seconds they took.
 *
 * Every file the listing reads is part of that revision, the workflows manifest beside the kinds manifest included: a
 * workflow's finding appears at the read after the edit and goes at the read after the file is fixed.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct, writeSamplePages } from './knowledge-fixture.js';
import { openProblemsOf } from '../src/problems/index.js';

const real = await import('../src/problems/index.js');
const realCollectProblems = real.collectProblems;
let collections = 0;
mock.module('../src/problems/index.js', () => ({
  ...real,
  collectProblems: async (input: Parameters<typeof realCollectProblems>[0]) => {
    collections += 1;
    return await realCollectProblems(input);
  },
}));

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

/** The 1-based line the file writes `text` on. */
const lineOf = (text: string, needle: string): number => text.split('\n').findIndex((line) => line.trim() === needle) + 1;

/** A workflows manifest with one workflow's stages replaced whole, every other line kept. */
function stagesOf(text: string, name: string, stages: readonly string[]): string {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const stagesAt = lines.findIndex((line, index) => index > start && line.startsWith('    stages:'));
  expect(stagesAt).toBeGreaterThan(-1);
  let end = stagesAt + 1;
  while (end < lines.length && lines[end]!.startsWith('      ')) end += 1;
  const written = stages.length === 0 ? ['    stages: []'] : ['    stages:', ...stages.map((stage) => `      - ${stage}`)];
  return [...lines.slice(0, stagesAt), ...written, ...lines.slice(end)].join('\n');
}

const SHOP = 'orders-shop';
const CODE = 'orders-code';
const DOMAIN = 'domain:payment';

let work: string;
let folder: string;
let server: StartedServer;

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/${SHOP}${path}`);
  return { status: response.status, body: await response.json() };
};

/** Every problem through the page's three levels. */
const allProblems = async (): Promise<any> => {
  const categories = (await get('/api/k/problems')).body;
  const problems: any[] = [];
  for (const category of categories.categories) {
    let after: string | undefined;
    for (;;) {
      const sources = (await get(`/api/k/problems?rule=${encodeURIComponent(category.rule)}${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`)).body;
      for (const source of sources.sources) {
        let cursor: string | undefined;
        for (;;) {
          const items = (await get(`/api/k/problems?rule=${encodeURIComponent(category.rule)}&source=${encodeURIComponent(source.key)}${cursor === undefined ? '' : `&after=${encodeURIComponent(cursor)}`}`)).body;
          problems.push(...items.problems);
          if (items.next === null) break;
          cursor = items.next;
        }
      }
      if (sources.next === null) break;
      after = sources.next;
    }
  }
  return { ...categories, problems };
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-problems-cache-'));
  const repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const price = 10;\n');
  git(repository, ['add', '.']);
  git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first']);
  const home = join(work, 'home');
  mkdirSync(home);
  folder = makeProduct(home, SHOP, repository, CODE);
  writeSamplePages(folder);
  git(folder, ['config', 'user.name', 'Ada Reader']);
  git(folder, ['config', 'user.email', 'ada@example.test']);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the count of problems is collected once per revision', () => {
  test('eight status polls at once collect the listing once', async () => {
    collections = 0;
    const answers = await Promise.all(Array.from({ length: 8 }, async () => await get('/api/k/status')));
    for (const answer of answers) expect(answer.status).toBe(200);
    // The eight polls share one collection. The collection is keyed after the reader opens, so their answers are
    // pending; the next status poll reads the listing under that key and carries its count without walking again.
    let problemsOpen: unknown;
    for (let i = 0; i < 200 && typeof problemsOpen !== 'number'; i += 1) {
      if (i > 0) await new Promise((rest) => setTimeout(rest, 10));
      const answer = await get('/api/k/status');
      expect(answer.status).toBe(200);
      problemsOpen = answer.body.loop.problemsOpen;
    }
    // The product holds findings of its own, so the count is a collection and not the fallback of the store's state.
    expect(typeof problemsOpen).toBe('number');
    expect(problemsOpen).toBeGreaterThan(0);
    expect(collections).toBe(1);
  });

  test('a page that asks while the polls run waits for the same collection, and a page alone collects nothing', async () => {
    collections = 0;
    const pages = await Promise.all(Array.from({ length: 4 }, async () => await get(`/api/k/page?id=${encodeURIComponent(DOMAIN)}`)));
    for (const page of pages) expect(page.status).toBe(200);
    expect(collections).toBe(0);
    const listing = await allProblems();
    expect(pages[0]!.body.problems).toBe(openProblemsOf(listing.problems, DOMAIN));
    expect(pages[0]!.body.problems).toBeGreaterThan(0);

    // A revision of the inputs the page reads: the next answer of the poll collects it again, once.
    const document = join(folder, 'docs', 'domains', 'payment.md');
    writeFileSync(document, readFileSync(document, 'utf8') + '\n');
    collections = 0;
    const answers = await Promise.all([
      ...[0, 1, 2, 3].map(async () => await get('/api/k/status')),
      ...[0, 1, 2, 3].map(async () => await get(`/api/k/page?id=${encodeURIComponent(DOMAIN)}`)),
    ]);
    for (const answer of answers) expect(answer.status).toBe(200);
    // The collection of the new revision runs in the background: it happens once, not once per answer.
    for (let i = 0; i < 200 && collections === 0; i += 1) await new Promise((rest) => setTimeout(rest, 10));
    expect(collections).toBe(1);
    await new Promise((rest) => setTimeout(rest, 250));
    expect(collections).toBe(1);
  });

  test('an edit of the workflows manifest makes its finding appear at the next read, and fixing the file takes it away', async () => {
    const file = join(folder, 'madarch', 'workflows.yaml');
    const original = readFileSync(file, 'utf8');
    const before = await allProblems();
    expect(before.problems.some((problem: { reason: string }) => problem.reason.includes('teleport'))).toBe(false);

    // The first fill's stages, one of them a stage the engine's registry does not hold: the finding is the manifest's
    // own, and the listing read again must be the listing of the file as it stands now.
    const broken = stagesOf(original, 'first-fill', ['teleport']);
    writeFileSync(file, broken);
    const listed = await allProblems();
    const finding = listed.problems.find((problem: { reason: string }) => problem.reason.includes('teleport')) as { file: string; line: number; reason: string } | undefined;
    expect(finding).toBeDefined();
    expect(finding!.file).toBe(file);
    expect(finding!.line).toBe(lineOf(broken, '- teleport'));
    expect(finding!.reason.startsWith('workflow "first-fill" stage "teleport": the engine\'s stage registry holds no stage "teleport"')).toBe(true);

    writeFileSync(file, original);
    const fixed = await allProblems();
    expect(fixed.problems.some((problem: { reason: string }) => problem.reason.includes('teleport'))).toBe(false);
    expect(fixed.open).toBe(before.open);
  }, 60_000);

  test('the poll follows an edit of the inputs at once, with the count of the Problems page', async () => {
    const manifest = readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8');
    expect(manifest).toContain('groups:\n');
    writeFileSync(join(folder, 'madarch', 'kinds.yaml'), manifest.replace('groups:\n', 'groups:\n  broken: { en: Broken, ru: Сломанное }\n'));
    const listing = await get('/api/k/problems');
    expect(listing.status).toBe(200);
    const status = await get('/api/k/status');
    expect(status.body.loop.problemsOpen).toBe(listing.body.open);
    expect(status.body.loop.problemsOpen).toBeGreaterThan(0);
  });
});
