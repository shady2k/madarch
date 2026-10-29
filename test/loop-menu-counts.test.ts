/**
 * The menu's counts of the loop (the owner's review of madarch-m38l.24): the tasks entry counts what the Tasks page
 * shows as open — a task a commit of a default branch closed is not open — and the problems entry follows the files the
 * Problems page reads, so a manifest edit shows at once instead of waiting for another revision.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { writeTask } from '../src/loop/tasks.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, args: string[], extra: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });

const SHOP = 'orders-shop';
const CODE = 'orders-code';
const READER = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };
/** The task's own moment, before the commit that closes it. */
const AT = '2026-10-24T09:00:00.000Z';

let work: string;
let folder: string;
let repository: string;
let server: StartedServer;

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/${SHOP}${path}`);
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-menu-counts-'));
  repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const price = 10;\n');
  git(repository, ['add', '.']);
  git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first']);
  const home = join(work, 'home');
  mkdirSync(home);
  folder = makeProduct(home, SHOP, repository, CODE);
  git(folder, ['config', 'user.name', 'Ada Reader']);
  git(folder, ['config', 'user.email', 'ada@example.test']);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  const warmed = await fetch(`${server.url}/products/${SHOP}/api/k/status`);
  expect(warmed.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the problems entry of the menu', () => {
  test('a manifest edit changes the count on the next poll, without another revision of the product', async () => {
    const before = await get('/api/k/status');
    expect(before.status).toBe(200);
    const problemsBefore = await get('/api/k/problems');
    expect(problemsBefore.status).toBe(200);
    // The menu already follows the Problems page: the fresh product has findings of its own (its documents lack the kinds
    // the starter manifest expects), so the count is read rather than assumed.
    expect(before.body.loop.problemsOpen).toBe(problemsBefore.body.open);

    // A group whose parent is not declared: the Problems page reads it as a finding, and no starter offer changes.
    const manifest = readFileSync(join(folder, 'madarch/kinds.yaml'), 'utf8');
    expect(manifest).toContain('groups:\n');
    writeFileSync(join(folder, 'madarch/kinds.yaml'), manifest.replace('groups:\n', 'groups:\n  broken: { en: Broken, ru: Сломано, parent: nowhere }\n'));

    const problems = await get('/api/k/problems');
    expect(problems.status).toBe(200);
    expect(problems.body.open).toBe(problemsBefore.body.open + 1);
    expect(problems.body.starter).toEqual([]);

    const after = await get('/api/k/status');
    expect(after.status).toBe(200);
    expect(after.body.loop.problemsOpen).toBe(problems.body.open);
    expect(after.body.starterOffers).toBe(before.body.starterOffers);
  }, 60_000);
});

describe('the tasks entry of the menu', () => {
  test('a task a commit of the default branch closed is not open in the menu, as the Tasks page says', async () => {
    writeFileSync(join(folder, 'docs/product.md'), '# Shop\n\nA shop.\n');
    git(folder, ['add', '--', 'docs/product.md']);
    git(folder, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Document the shop']);
    writeTask(folder, 'docs/tasks/fix-price.md', {
      slug: 'fix-price', title: 'Fix the price', status: 'open', question: 'question:price', answer: 'answer:price',
      grounds: ['code.file\u003asrc/a.ts'], scope: [{ type: 'file', path: 'docs/product.md' }], by: { ...READER }, at: AT,
      closedBy: null, closedAt: null,
    });
    // The planning commit names the task but touches none of its scope: the task is still open after it.
    git(folder, ['add', '--', 'docs/tasks/fix-price.md']);
    git(folder, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Plan the task fix-price']);
    const stillOpen = await get('/api/k/tasks');
    expect([stillOpen.body.open, stillOpen.body.closed]).toEqual([1, 0]);

    // The commit that closes it: it names the task and changes the file its scope names, on the product's default branch.
    writeFileSync(join(folder, 'docs/product.md'), '# Shop\n\nA shop with prices.\n');
    const dated = { GIT_AUTHOR_DATE: '2026-10-24T09:01:00.000Z', GIT_COMMITTER_DATE: '2026-10-24T09:01:00.000Z' };
    git(folder, ['add', '--', 'docs/product.md'], dated);
    git(folder, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fix the price\n\nTask: fix-price'], dated);

    const tasks = await get('/api/k/tasks');
    expect(tasks.status).toBe(200);
    expect([tasks.body.open, tasks.body.closed]).toEqual([0, 1]);
    expect(tasks.body.tasks[0].status).toBe('closed');

    const status = await get('/api/k/status');
    expect(status.status).toBe(200);
    // The menu's tasks entry counts what the Tasks page shows, by the same closure calculation (product.ts loopCounts).
    expect(status.body.loop.tasksOpen).toBe(0);
  }, 60_000);
});

