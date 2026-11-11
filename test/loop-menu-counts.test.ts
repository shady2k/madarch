/** The menu problems count follows a committed manifest edit without another server start. */
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(60_000);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct, makeProduct, withoutPluginTurns } from './knowledge-fixture.js';
import { fillInProcess } from './fill-inline.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, args: string[], extra: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });

const SHOP = 'orders-shop';
const CODE = 'orders-code';
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
    const problemsBefore = await get('/api/problems');
    const before = await statusWithCount();
    expect(problemsBefore.status).toBe(200);
    // The menu already follows the Problems page: the fresh product has findings of its own (its documents lack the kinds
    // the starter manifest expects), so the count is read rather than assumed.
    expect(before.body.loop.problemsOpen).toBe(problemsBefore.body.open);

    // A group whose parent is not declared: the Problems page reads it as a finding.
    const manifest = readFileSync(join(folder, 'madarch/kinds.yaml'), 'utf8');
    expect(manifest).toContain('groups:\n');
    writeFileSync(join(folder, 'madarch/kinds.yaml'), manifest.replace('groups:\n', 'groups:\n  broken: { en: Broken, ru: Сломано, parent: nowhere }\n'));
    // The edit is the product repository's commit, and the fill stores it: a reader of a page reads the graph.
    commitProduct(folder, 'Declare a group whose parent is not declared');
    await fill();

    const problems = await get('/api/problems');
    expect(problems.status).toBe(200);
    expect(problems.body.open).toBe(problemsBefore.body.open + 1);

    // The edit moved the key the count stands under, so the next answers are pending until the listing of the new files
    // lands — and the count they then carry is the new one, never the old one (a listing of other inputs is not answered).
    const after = await statusWithCount();
    expect(after.body.loop.problemsOpen).toBe(problems.body.open);
  }, 60_000);
});

