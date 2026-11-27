/**
 * One product, one store, one opening (madarch-8bdc.2.5, item 4c): two simultaneous first requests for one product
 * wait on one opening of its store, and one run of a store at a time — the second start is the chain's own refusal,
 * never a second connection or a stopped first run.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStorePreparationOwner } from '../src/product/store-preparation.js';
import { daemonFills } from '../src/product/daemon-fills.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createTestDatabaseOwner } from './test-database.js';
import { useRepositoryPlugins, useFixturePlugins } from './enabled-plugins-fixture.js';
import { traceFiles } from '../src/obs/trace.js';
import { readKindAssertions } from '../src/graph/records.js';

const ROOT = mkdtempSync(join(tmpdir(), 'madarch-daemon-one-'));
const HOME = join(ROOT, 'products');
const PRODUCT = join(HOME, 'shop');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

beforeAll(() => {
  mkdirSync(join(PRODUCT, 'src'), { recursive: true });
  writeFileSync(join(PRODUCT, 'workspace.yaml'), 'schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: shop\n');
  writeFileSync(join(PRODUCT, 'src', 'order.ts'), 'export function checkout(): number {\n  return 42;\n}\n');
  useRepositoryPlugins(PRODUCT);
  useFixturePlugins(PRODUCT, ['disk']);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: PRODUCT, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: PRODUCT, env: GIT_ENV });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'one'], { cwd: PRODUCT, env: GIT_ENV });
}, 120_000);

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('two simultaneous first runs of one product', () => {
  test('open one store, and the second start is the chain\'s refusal', async () => await withStorePreparationOwner(async () => {
    const fills = daemonFills(HOME, { unconfined: true });
    const request = { product: { name: 'shop', folder: PRODUCT } };
    try {
      const answers = await Promise.all([
        fills.run({ ...request, runId: 'simultaneous-a' }),
        fills.run({ ...request, runId: 'simultaneous-b' }),
      ]);
      const refused = answers.filter((answer) => !answer.ok);
      const ran = answers.filter((answer) => answer.ok);
      // One owner, one run: the other start is refused by the chain, and its reason names the store's fill.
      expect(ran).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const held = refused[0]!;
      if (held.ok) return;
      expect(held.code).toBe('fill-orchestrator/chain-active');
      expect(held.reason).toContain('is filling');
      const finished = ran[0]!;
      if (!finished.ok) return;
      const store = productStoreFolder(PRODUCT, knowledgeRootOf(HOME));
      let failure: string | undefined;
      if (finished.state !== 'succeeded') {
        const trace = traceFiles(store).find(trace => trace.runId === finished.runId);
        const errors = trace === undefined ? [] : readFileSync(trace.file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as { name: string; status?: { code?: string; message?: string }; events?: unknown[] }).filter(span => span.status?.code === 'STATUS_CODE_ERROR').map(({ name, status, events }) => ({ name, status, events }));
        failure = JSON.stringify({ finished, trace: trace?.file, errors });
      }
      expect(finished.state, failure).toBe('succeeded');
      // The one store holds the one run, and the refused run id stands nowhere: no second database took it.
      const owner = await createTestDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
      await owner.ready;
      try {
        // A run is a graph vertex (0039 item 19), not a table of the store: the run the store holds is the one that ran.
        const runs = await owner.run((tx) => readKindAssertions(tx, 'vertex', 'system.run', ['run_name'], { contract: owner.graphContract }));
        expect(runs.map((row) => String(row.values['run_name']))).toEqual([finished.runId]);
      } finally {
        await owner.close();
      }
    } finally {
      await fills.stop();
    }
  }), 300_000);
});
