/**
 * One product, one store, one opening (madarch-8bdc.2.5, item 4c): two simultaneous first requests for one product
 * wait on one opening of its store, and one run of a store at a time — the second start is the chain's own refusal,
 * never a second connection or a stopped first run.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonFills } from '../src/product/daemon.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createTestDatabaseOwner } from './test-database.js';

const ROOT = mkdtempSync(join(tmpdir(), 'madarch-daemon-one-'));
const HOME = join(ROOT, 'products');
const PRODUCT = join(HOME, 'shop');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

beforeAll(() => {
  mkdirSync(join(PRODUCT, 'src'), { recursive: true });
  writeFileSync(join(PRODUCT, 'workspace.yaml'), 'schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: shop\n');
  writeFileSync(join(PRODUCT, 'src', 'order.ts'), 'export function checkout(): number {\n  return 42;\n}\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: PRODUCT, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: PRODUCT, env: GIT_ENV });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'one'], { cwd: PRODUCT, env: GIT_ENV });
}, 120_000);

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('two simultaneous first runs of one product', () => {
  test('open one store, and the second start is the chain\'s refusal', async () => {
    const fills = daemonFills(HOME);
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
      expect(finished.state).toBe('succeeded');
      // The one store holds the one run, and the refused run id stands nowhere: no second database took it.
      const store = productStoreFolder(PRODUCT, knowledgeRootOf(HOME));
      const owner = await createTestDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
      await owner.ready;
      try {
        const runs = await owner.run((tx) => tx.query<{ run_id: string }>('SELECT run_id FROM fill_run ORDER BY run_id'));
        expect(runs.rows.map((row) => row.run_id)).toEqual([finished.runId]);
      } finally {
        await owner.close();
      }
    } finally {
      await fills.stop();
    }
  }, 300_000);
});
