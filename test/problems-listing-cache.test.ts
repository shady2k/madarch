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
import { afterAll, beforeAll, describe, expect, mock, test, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(60_000);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct, makeProduct, writeSamplePages, withoutPluginTurns } from './knowledge-fixture.js';
import { openProblemsOf } from '../src/problems/index.js';
import { fillInProcess } from './fill-inline.js';

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

const SHOP = 'orders-shop';
const CODE = 'orders-code';
const DOMAIN = 'domain:payment';

let work: string;
let home: string;
let folder: string;
let server: StartedServer;

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/${SHOP}${path}`);
  return { status: response.status, body: await response.json() };
};

/** Every problem through the page's three levels. */
const allProblems = async (): Promise<any> => {
  const categories = (await get('/api/problems')).body;
  const problems: any[] = [];
  for (const category of categories.categories) {
    let after: string | undefined;
    for (;;) {
      const sources = (await get(`/api/problems?rule=${encodeURIComponent(category.rule)}${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`)).body;
      for (const source of sources.sources) {
        let cursor: string | undefined;
        for (;;) {
          const items = (await get(`/api/problems?rule=${encodeURIComponent(category.rule)}&source=${encodeURIComponent(source.key)}${cursor === undefined ? '' : `&after=${encodeURIComponent(cursor)}`}`)).body;
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
  home = join(work, 'home');
  mkdirSync(home);
  folder = makeProduct(home, SHOP, repository, CODE);
  withoutPluginTurns(folder);
  writeSamplePages(folder);
  git(folder, ['config', 'user.name', 'Ada Reader']);
  git(folder, ['config', 'user.email', 'ada@example.test']);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  await fill();
}, 180_000);

/** One pass of the files producer in this process: a page reads the graph, and a write reaches it at the next pass. */
async function fill(): Promise<void> {
  await fillInProcess(folder, home, join(work, 'store'));
  await get('/api/status');
}

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the count of problems is collected once per revision', () => {
  test('eight status polls at once collect the listing once', async () => {
    collections = 0;
    const answers = await Promise.all(Array.from({ length: 8 }, async () => await get('/api/status')));
    for (const answer of answers) expect(answer.status).toBe(200);
    // The eight polls share one collection. The collection is keyed after the reader opens, so their answers are
    // pending; the next status poll reads the listing under that key and carries its count without walking again.
    let problemsOpen: unknown;
    for (let i = 0; i < 200 && typeof problemsOpen !== 'number'; i += 1) {
      if (i > 0) await new Promise((rest) => setTimeout(rest, 10));
      const answer = await get('/api/status');
      expect(answer.status).toBe(200);
      problemsOpen = answer.body.loop.problemsOpen;
    }
    // The product holds findings of its own, so the count is a collection and not the fallback of the store's state.
    expect(typeof problemsOpen).toBe('number');
    expect(problemsOpen).toBeGreaterThan(0);
    expect(collections).toBeLessThanOrEqual(1);
    const listing = await allProblems();
    expect(problemsOpen).toBe(listing.open);
  });

  test('a page that asks while the polls run waits for the same collection, and a page alone collects nothing', async () => {
    collections = 0;
    const pages = await Promise.all(Array.from({ length: 4 }, async () => await get(`/api/page?id=${encodeURIComponent(DOMAIN)}`)));
    for (const page of pages) expect(page.status).toBe(200);
    expect(collections).toBe(0);
    const listing = await allProblems();
    expect(pages[0]!.body.problems).toBe(openProblemsOf(listing.problems, DOMAIN));
    expect(pages[0]!.body.problems).toBeGreaterThan(0);

    // A revision of the inputs the page reads: a committed edit the fill stores, and the poll collects it again, once.
    const document = join(folder, 'docs', 'domains', 'payment.md');
    writeFileSync(document, readFileSync(document, 'utf8') + '\n');
    commitProduct(folder, 'Touch the payment domain');
    await fill();
    collections = 0;
    const answers = await Promise.all([
      ...[0, 1, 2, 3].map(async () => await get('/api/status')),
      ...[0, 1, 2, 3].map(async () => await get(`/api/page?id=${encodeURIComponent(DOMAIN)}`)),
    ]);
    for (const answer of answers) expect(answer.status).toBe(200);
    // The collection of the new revision runs in the background: it happens once, not once per answer.
    for (let i = 0; i < 200 && collections === 0; i += 1) await new Promise((rest) => setTimeout(rest, 10));
    expect(collections).toBeLessThanOrEqual(1);
    await new Promise((rest) => setTimeout(rest, 250));
    expect(collections).toBeLessThanOrEqual(1);
  });

  test('an edit of the kinds manifest makes its finding appear at the read after the fill, and fixing the file takes it away', async () => {
    const file = join(folder, 'madarch', 'kinds.yaml');
    const original = readFileSync(file, 'utf8');
    const before = await allProblems();
    expect(before.problems.some((problem: { reason: string }) => problem.reason.includes('probe-field'))).toBe(false);

    // A kind that names a template the product does not hold: the finding is the manifest's own, and the listing read
    // after the fill that stored the file is the listing of the file as it stands now.
    const kindsAt = original.indexOf('\nkinds:\n');
    expect(kindsAt).toBeGreaterThan(-1);
    const line = '  probe-kind: { template: templates/probe-absent.liquid, source: markdown, folder: docs/probe }';
    const broken = `${original.slice(0, kindsAt + '\nkinds:\n'.length)}${line}\n${original.slice(kindsAt + '\nkinds:\n'.length)}`;
    try {
      writeFileSync(file, broken);
      commitProduct(folder, 'Declare a kind whose template is not there');
      await fill();
      const listed = await allProblems();
      const finding = listed.problems.find((problem: { reason: string }) => problem.reason.includes('probe-absent')) as { file: string; line: number; reason: string } | undefined;
      expect(finding).toBeDefined();
      expect(finding!.file).toBe(file);
      expect(finding!.line).toBe(lineOf(broken, line.trim()));
      expect(finding!.reason).toContain('probe-absent');
    } finally {
      writeFileSync(file, original);
      commitProduct(folder, 'Restore the kinds manifest');
    }
    await fill();
    const fixed = await allProblems();
    expect(fixed.problems.some((problem: { reason: string }) => problem.reason.includes('probe-absent'))).toBe(false);
    expect(fixed.open).toBe(before.open);
  }, 60_000);

  test('the poll follows a committed edit once the fill stores it, with the count of the Problems page', async () => {
    const manifest = readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8');
    expect(manifest).toContain('groups:\n');
    writeFileSync(join(folder, 'madarch', 'kinds.yaml'), manifest.replace('groups:\n', 'groups:\n  broken: { en: Broken, ru: Сломанное }\n'));
    commitProduct(folder, 'Declare a group no kind names');
    await fill();
    const listing = await get('/api/problems');
    expect(listing.status).toBe(200);
    const status = await get('/api/status');
    expect(status.body.loop.problemsOpen).toBe(listing.body.open);
    expect(status.body.loop.problemsOpen).toBeGreaterThan(0);
  });
});
