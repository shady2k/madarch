/**
 * A status answer costs one read of its files per key, not one per poll (madarch-u3vw.1, the second review). The menu
 * polls the status of every open page, and the answer used to build the whole render context each time: the manifest
 * (a YAML parse of every kind, eleven milliseconds of the answer), every Markdown page, every document and the loop's
 * files. The counter wraps `readKinds`, the one function that reads the manifest, so the test counts the reads
 * themselves and not the milliseconds they took. A file a person writes beside the server is still seen on the next
 * answer: the key is the stamp of the files the answer reads, not a clock.
 */
import { afterAll, beforeAll, describe, expect, mock, test, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(60_000);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_DOMAIN, SAMPLE_IDENTITY, commitProduct, makeProduct, writeSamplePages, withoutPluginTurns } from './knowledge-fixture.js';
import { fillInProcess } from './fill-inline.js';
import { publishSamplePageOpinions } from './knowledge-page-opinions.js';

const realKinds = await import('../src/product/manifest/kinds.js');
const realReadKinds = realKinds.readKinds;
let manifestReads = 0;
mock.module('../src/product/manifest/kinds.js', () => ({
  ...realKinds,
  readKinds: (folder: string) => {
    manifestReads += 1;
    return realReadKinds(folder);
  },
}));

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

const SHOP = 'stamp-shop';
const CODE = 'stamp-code';

let work: string;
let home: string;
let folder: string;
let server: StartedServer;

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/${SHOP}${path}`);
  return { status: response.status, body: await response.json() };
};
const countOf = (body: { kinds: { kind: string; count: number }[] }, kind: string): number | undefined => body.kinds.find((entry) => entry.kind === kind)?.count;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-status-work-'));
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
  await publishSamplePageOpinions(folder, join(work, 'store'));
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

describe('a status answer reads the manifest once per key', () => {
  test('eight polls of an unchanged product read the manifest file not at all, and the manifest once per graph revision', async () => {
    // The reader a product starts on its first answer moves the key once (its snapshot number joins the key): a poll
    // that finds the reader open is the poll this bounds.
    const warm = await get('/api/status');
    expect(warm.status).toBe(200);
    expect((await get('/api/status')).status).toBe(200);
    // The product is unchanged only once two things the first answers started have landed: the starter set the server
    // brings up to date (a write of the manifest and its templates) and the Problems collection it starts beside itself,
    // which reads the manifest too. A count that stands (`loop.problemsOpen`) and an answer that reads nothing are what
    // say so (measured under load: either can land after the two warm answers, and the next answer then reads).
    let settled = manifestReads;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const answer = await get('/api/status');
      expect(answer.status).toBe(200);
      if (typeof (answer.body as { loop?: { problemsOpen?: unknown } }).loop?.problemsOpen === 'number' && manifestReads === settled) break;
      settled = manifestReads;
    }
    manifestReads = 0;
    const answers = await Promise.all(Array.from({ length: 8 }, async () => await get('/api/status')));
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(manifestReads, 'the eight polls of an unchanged product read the manifest between them').toBe(0);
    for (const answer of answers) expect(countOf(answer.body, 'domain')).toBe(1);
  });

  test('an explicitly published page updates the graph revision after its source is committed', async () => {
    const before = await get('/api/status');
    expect(countOf(before.body, 'domain')).toBe(1);
    const refund = SAMPLE_DOMAIN.replace('id: domain:payment', 'id: domain:refund').replace('title: Payment', 'title: Refund');
    writeFileSync(join(folder, 'docs', 'domains', 'refund.md'), refund);
    // File bytes are not graph opinions: neither an uncommitted write nor a fill imports a page.
    expect(countOf((await get('/api/status')).body, 'domain')).toBe(1);
    commitProduct(folder, 'Write the refund domain');
    await fill();
    await publishSamplePageOpinions(folder, join(work, 'store'), [{
      kind: 'domain', slug: 'refund', title: 'Refund', file: 'docs/domains/refund.md',
      body: 'Refunds return captured payments.', relates: [], sources: ['docs/requirements.md'],
    }]);
    const after = await get('/api/status');
    expect(after.status).toBe(200);
    expect(countOf(after.body, 'domain'), 'a page explicitly published to the graph').toBe(2);
  });

  test('a manifest edited and committed beside the product shows after the fill, and the wiki never reads the file itself', async () => {
    manifestReads = 0;
    const file = join(folder, 'madarch', 'kinds.yaml');
    const manifest = parseDocument(readFileSync(file, 'utf8'));
    manifest.setIn(['groups', 'stamp-probe'], { en: 'Stamp probe', ru: 'Проба чекана' });
    manifest.addIn(['roles', 'developer', 'lead'], 'stamp-probe');
    writeFileSync(file, manifest.toString());
    expect((await get('/api/status')).body.groups.map((group: { group: string }) => group.group)).not.toContain('stamp-probe');
    commitProduct(folder, 'Declare a probe group');
    await fill();
    // Starting a fill is a write path and reads the working tree once; a reader of a page reads the graph alone.
    manifestReads = 0;
    const answer = await get('/api/status');
    expect(answer.status).toBe(200);
    expect((answer.body.groups as { group: string }[]).map((group) => group.group)).toContain('stamp-probe');
    expect(manifestReads, "the working tree's manifest, read by a reader of a page").toBe(0);
  });
});
