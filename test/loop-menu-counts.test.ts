/**
 * The menu's counts of the loop (the owner's review of madarch-m38l.24): the tasks entry counts what the Tasks page
 * shows as open — a task a commit of a default branch closed is not open — and the problems entry follows the files the
 * Problems page reads, so a manifest edit shows at once instead of waiting for another revision.
 */
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(60_000);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { writeTask } from '../src/loop/tasks.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct, makeProduct, withoutPluginTurns } from './knowledge-fixture.js';
import { fillInProcess } from './fill-inline.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, args: string[], extra: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });

const SHOP = 'orders-shop';
const CODE = 'orders-code';
const READER = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };
/** The task's own moment, before the commit that closes it. */
const AT = '2026-10-24T09:00:00.000Z';

let work: string;
let home: string;
let folder: string;
let repository: string;
let server: StartedServer;

interface Answer {
  readonly status: number;
  readonly body: any;
}

const get = async (path: string): Promise<Answer> => {
  const response = await fetch(`${server.url}/products/${SHOP}${path}`);
  return { status: response.status, body: await response.json() };
};

/**
 * How long the menu's problems count is waited for, and why it has to be waited for: the count is the Problems page's
 * listing, which the status answer *collects beside itself* — `statusLiveNow` (`src/knowledge/product.ts`) answers a
 * pending menu (`loop.problemsOpen` absent, madarch-u3vw.8) while no listing stands for the files the answer read, and the
 * collection walks the product's graph. A poll right after the server's first answer, or right after an edit (the key
 * moves with the file), can therefore arrive before the collection lands — it took 25 ms to 1 s here on two loaded cores.
 * Ten seconds is a defect, not a wait: the collection of a fixture product is about a second.
 */
const COUNT_WITHIN_MS = 10_000;

/** The status answer whose menu count stands: polls until `loop.problemsOpen` is a number, and fails naming the wait. */
async function statusWithCount(): Promise<Answer> {
  const deadline = Date.now() + COUNT_WITHIN_MS;
  for (;;) {
    const answer = await get('/api/status');
    expect(answer.status).toBe(200);
    if (typeof answer.body.loop?.problemsOpen === 'number') return answer;
    if (Date.now() > deadline) throw new Error(`the menu's problems count was still pending after ${String(COUNT_WITHIN_MS)} ms: ${JSON.stringify(answer.body.loop)}`);
    await new Promise((rest) => setTimeout(rest, 25));
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-menu-counts-'));
  repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const price = 10;\n');
  git(repository, ['add', '.']);
  git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first']);
  home = join(work, 'home');
  mkdirSync(home);
  folder = makeProduct(home, SHOP, repository, CODE);
  withoutPluginTurns(folder);
  git(folder, ['config', 'user.name', 'Ada Reader']);
  git(folder, ['config', 'user.email', 'ada@example.test']);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  const warmed = await fetch(`${server.url}/products/${SHOP}/api/status`);
  expect(warmed.status).toBe(200);
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

describe('the problems entry of the menu', () => {
  test('a manifest edit changes the count on the next poll, without another revision of the product', async () => {
    // The count is collected beside the status answer (`statusWithCount`), so the first answers of a product may be pending.
    const before = await statusWithCount();
    const problemsBefore = await get('/api/problems');
    expect(problemsBefore.status).toBe(200);
    // The menu already follows the Problems page: the fresh product has findings of its own (its documents lack the kinds
    // the starter manifest expects), so the count is read rather than assumed.
    expect(before.body.loop.problemsOpen).toBe(problemsBefore.body.open);

    // A group whose parent is not declared: the Problems page reads it as a finding, and no starter offer changes.
    const manifest = readFileSync(join(folder, 'madarch/kinds.yaml'), 'utf8');
    expect(manifest).toContain('groups:\n');
    writeFileSync(join(folder, 'madarch/kinds.yaml'), manifest.replace('groups:\n', 'groups:\n  broken: { en: Broken, ru: Сломано, parent: nowhere }\n'));
    // The edit is the product repository's commit, and the fill stores it: a reader of a page reads the graph.
    commitProduct(folder, 'Declare a group whose parent is not declared');
    await fill();

    const problems = await get('/api/problems');
    expect(problems.status).toBe(200);
    expect(problems.body.open).toBe(problemsBefore.body.open + 1);
    expect(problems.body.starter).toEqual([]);

    // The edit moved the key the count stands under, so the next answers are pending until the listing of the new files
    // lands — and the count they then carry is the new one, never the old one (a listing of other inputs is not answered).
    const after = await statusWithCount();
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
    await fill();
    const stillOpen = await get('/api/tasks');
    expect([stillOpen.body.open, stillOpen.body.closed]).toEqual([1, 0]);

    // The commit that closes it: it names the task and changes the file its scope names, on the product's default branch.
    writeFileSync(join(folder, 'docs/product.md'), '# Shop\n\nA shop with prices.\n');
    const dated = { GIT_AUTHOR_DATE: '2026-10-24T09:01:00.000Z', GIT_COMMITTER_DATE: '2026-10-24T09:01:00.000Z' };
    git(folder, ['add', '--', 'docs/product.md'], dated);
    git(folder, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fix the price\n\nTask: fix-price'], dated);
    await fill();

    const tasks = await get('/api/tasks');
    expect(tasks.status).toBe(200);
    expect([tasks.body.open, tasks.body.closed]).toEqual([0, 1]);
    expect(tasks.body.tasks[0].status).toBe('closed');

    const status = await get('/api/status');
    expect(status.status).toBe(200);
    // The menu's tasks entry counts what the Tasks page shows, by the same closure calculation (product.ts loopCounts).
    expect(status.body.loop.tasksOpen).toBe(0);
  }, 60_000);
});

