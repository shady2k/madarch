
/**
 * The kind's page and the agent's spend (madarch-stm0.4, decision 0035, item 22): what a model call of a plugin's agent
 * part cost is in the store's mechanism tables, and `/api/kind-usage` answers it per run, plugin run, field and model —
 * every run counted, the newest listed. No model and no agent runs here: the rows are the store's own, written by the
 * same adapter a metered turn writes through.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { recordAgentUsage, type AgentUsageRecord } from '../src/adapters/agent-usage.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';
let folder = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-agent-usage-page-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  const repository = join(root, 'shop-code');
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  writeFileSync(join(repository, 'README.md'), '# Shop\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'the shop');
  folder = makeProduct(home, 'usage-shop', repository, 'shop');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', 'the product');
}, 120_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

async function server(): Promise<StartedServer> {
  return await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}

async function call(started: StartedServer, path: string): Promise<{ status: number; body: any }> {
  const answer = await fetch(`${started.url}/products/usage-shop${path}`);
  return { status: answer.status, body: await answer.json() };
}

/** One metered row, as a fill's unit writes it through `recordAgentUsage`. */
function row(overrides: Partial<AgentUsageRecord> = {}): AgentUsageRecord {
  return {
    run: 'fill-1', unit: 'glossary:doc.term', plugin: 'glossary', pluginVersion: '1.0.0', kind: 'doc.term', field: 'definition',
    model: 'sonnet', inputTokens: 800, outputTokens: 200, totalTokens: 1000, cost: { amount: 0.02, currency: 'USD' },
    turns: 1, reported: true, stopped: null, ...overrides,
  };
}

describe('what the agent spent on a kind, over the API the page reads', () => {
  test('a kind no model call filled answers no spend, and the ask without a kind is refused by name', async () => {
    const started = await server();
    try {
      const empty = await call(started, '/api/kind-usage?kind=doc.term');
      expect(empty.status).toBe(200);
      expect(empty.body.usage).toEqual({ kind: 'doc.term', runs: [], moreRuns: false, total: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: [], runs: 0 } });
      const missing = await call(started, '/api/kind-usage');
      expect(missing.status).toBe(400);
      expect(missing.body.error.field).toBe('kind');
    } finally {
      await started.stop();
    }
  }, 60_000);

  test('the store\'s rows answer per run, plugin run, field and model, newest run first', async () => {
    const store = storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home)));
    const owner = await createDatabaseOwner({ store, btreeGist: true });
    try {
      await recordAgentUsage(owner, [
        row({ run: 'fill-1' }),
        row({ run: 'fill-2', unit: 'sections:doc.term', plugin: 'sections', pluginVersion: '2.0.0', model: null, inputTokens: 2000, outputTokens: 500, totalTokens: 2500, cost: null, turns: 2, stopped: 'tokens' }),
        row({ run: 'fill-2', kind: 'code.file', field: 'path', plugin: 'files' }),
      ]);
    } finally {
      await owner.close();
    }
    const started = await server();
    try {
      const answered = await call(started, '/api/kind-usage?kind=doc.term');
      expect(answered.status).toBe(200);
      const usage = answered.body.usage;
      expect(usage.runs.map((run: { run: string }) => run.run)).toEqual(['fill-2', 'fill-1']);
      expect(usage.total).toEqual({ inputTokens: 2800, outputTokens: 700, totalTokens: 3500, cost: [{ amount: 0.02, currency: 'USD' }], runs: 2 });
      expect(usage.runs[0].rows[0]).toMatchObject({ plugin: 'sections', field: 'definition', model: null, stopped: 'tokens' });
      // The code.file row is another kind's spend: it never leaks into the term page.
      expect(usage.runs.flatMap((run: { rows: { kind: string }[] }) => run.rows).every((line: { kind: string }) => line.kind === 'doc.term')).toBe(true);
    } finally {
      await started.stop();
    }
  }, 60_000);
});
