/**
 * A count is collected once per revision of the inputs the Problems page reads (madarch-m38l.19). The menu's count and
 * the badge of a page used to collect the listing for themselves, so eight status polls at once during a fill walked the
 * graph eight times and each page walked it again; on the pod that held the store long enough for a poll to answer in
 * 442 ms instead of under 300 ms.
 *
 * The counter wraps the one function that walks the graph, `collectProblems`, so the test counts the walks themselves,
 * not the seconds they took.
 *
 * A valid committed manifest edit moves that revision after a fill. An invalid manifest refuses the fill with its
 * file and line and leaves the last published listing intact. Pages and templates are explicit graph opinions.
 */
import { afterAll, beforeAll, describe, expect, mock, test, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(60_000);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct, makeProduct, writeSamplePages, withoutPluginTurns } from './knowledge-fixture.js';
import { openProblemsOf } from '../src/problems/index.js';
import { fillInProcess } from './fill-inline.js';
import { publishFixtureOpinions } from './knowledge-page-opinions.js';
import { parseDocument } from 'yaml';

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
  server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  await fill();
  await publishFixtureOpinions(folder, join(work, 'store'), [{
    kind: 'domain', key: { slug: 'payment' },
    values: {
      title: 'Payment', file: 'docs/domains/payment.md', body: 'Payments use a provider.', body_line: 1,
      relates: [], sources: ['docs/requirements.md'], producer: 'fixture', digest: 'payment-fixture',
      statements: [{ id: 'provider', text: 'Payments use a provider.', digest: 'provider-fixture', labels: [], mentions: [], grounds: ['code.service:absent-provider'], line: 1 }],
      mentions: [], links: [], findings: [], ungrounded: [],
    },
  }, {
    kind: 'template', key: { path: 'templates/domain.liquid' },
    values: { template_parts: [{ type: 'block', name: 'properties', params: { title: 'Details' }, line: 1 }] },
  }]);
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
    for (const page of pages) expect(page.status, JSON.stringify(page.body)).toBe(200);
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

  test('an invalid kinds manifest refuses the fill with its file and line, without changing the published listing', async () => {
    const file = join(folder, 'madarch/kinds/code/analysis/probe-kind.yaml');
    const before = await allProblems();
    const line = 'template: templates/probe-absent.liquid';
    const broken = `${line}
source: markdown
folder: docs/probe
`;
    try {
      writeFileSync(file, broken);
      commitProduct(folder, 'Declare an invalid kind');
      await expect(fill()).rejects.toThrow(`${file}:${lineOf(broken, line.trim())}: kind "probe-kind"`);
      const listed = await allProblems();
      expect(listed.problems).toEqual(before.problems);
      expect(listed.open).toBe(before.open);
    } finally {
      rmSync(file);
      commitProduct(folder, 'Restore the kinds manifest');
    }
    await fill();
    const fixed = await allProblems();
    expect(fixed.problems.some((problem: { reason: string }) => problem.reason.includes('probe-absent'))).toBe(false);
    expect(fixed.open).toBe(before.open);
  }, 60_000);

  test('the poll follows a committed edit once the fill stores it, with the count of the Problems page', async () => {
    const file = join(folder, 'madarch', 'catalog.yaml');
    const manifest = parseDocument(readFileSync(file, 'utf8'));
    manifest.setIn(['groups', 'cache-probe'], { en: 'Cache probe', ru: 'Проба кеша', short: { en: 'Cache probe', ru: 'Проба кеша' } });
    manifest.addIn(['roles', 'developer', 'lead'], 'cache-probe');
    writeFileSync(file, manifest.toString());
    commitProduct(folder, 'Declare a valid probe group');
    collections = 0;
    await fill();
    const listing = await get('/api/problems');
    expect(listing.status).toBe(200);
    expect(collections).toBe(1);
    const status = await get('/api/status');
    expect(status.body.groups.map((group: { group: string }) => group.group)).toContain('cache-probe');
    expect(collections).toBe(1);
    expect(status.body.loop.problemsOpen).toBe(listing.body.open);
    expect(status.body.loop.problemsOpen).toBeGreaterThan(0);
  });
});
