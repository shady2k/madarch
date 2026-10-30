/**
 * A status answer costs one read of its files per key, not one per poll (madarch-u3vw.1, the second review). The menu
 * polls the status of every open page, and the answer used to build the whole render context each time: the manifest
 * (a YAML parse of every kind, eleven milliseconds of the answer), every Markdown page, every document and the loop's
 * files. The counter wraps `readKinds`, the one function that reads the manifest, so the test counts the reads
 * themselves and not the milliseconds they took. A file a person writes beside the server is still seen on the next
 * answer: the key is the stamp of the files the answer reads, not a clock.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_DOMAIN, SAMPLE_IDENTITY, makeProduct, writeSamplePages } from './knowledge-fixture.js';

const realKinds = await import('../src/knowledge/kinds.js');
const realReadKinds = realKinds.readKinds;
let manifestReads = 0;
mock.module('../src/knowledge/kinds.js', () => ({
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

describe('a status answer reads the manifest once per key', () => {
  test('eight polls of an unchanged product read the manifest not at all', async () => {
    // The reader a product starts on its first answer moves the key once (its snapshot number joins the key): a poll
    // that finds the reader open is the poll this bounds.
    const warm = await get('/api/k/status');
    expect(warm.status).toBe(200);
    expect((await get('/api/k/status')).status).toBe(200);
    manifestReads = 0;
    const answers = await Promise.all(Array.from({ length: 8 }, async () => await get('/api/k/status')));
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(manifestReads, 'the eight polls of an unchanged product read the manifest between them').toBe(0);
    for (const answer of answers) expect(countOf(answer.body, 'domain')).toBe(1);
  });

  test('a page written beside the product shows on the next answer', async () => {
    const before = await get('/api/k/status');
    expect(countOf(before.body, 'domain')).toBe(1);
    const refund = SAMPLE_DOMAIN.replace('id: domain:payment', 'id: domain:refund').replace('title: Payment', 'title: Refund');
    writeFileSync(join(folder, 'docs', 'domains', 'refund.md'), refund);
    const after = await get('/api/k/status');
    expect(after.status).toBe(200);
    expect(countOf(after.body, 'domain'), 'a page written beside the server').toBe(2);
  });

  test('a manifest edited beside the product is read again and its answer shows the new group', async () => {
    manifestReads = 0;
    const file = join(folder, 'madarch', 'kinds.yaml');
    const manifest = parseDocument(readFileSync(file, 'utf8'));
    manifest.setIn(['groups', 'stamp-probe'], { en: 'Stamp probe', ru: 'Проба чекана' });
    writeFileSync(file, manifest.toString());
    const answer = await get('/api/k/status');
    expect(answer.status).toBe(200);
    expect((answer.body.groups as { group: string }[]).map((group) => group.group)).toContain('stamp-probe');
    expect(manifestReads, 'the manifest read for an edited manifest').toBeGreaterThan(0);
  });
});
