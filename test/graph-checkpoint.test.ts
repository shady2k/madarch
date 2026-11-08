/**
 * The WAL checkpoint the store runs while a fill publishes (madarch-8bdc.2.5, item 5).
 *
 * PGlite runs PostgreSQL in single-user mode, where no checkpointer process exists: the
 * whole-repository fill wrote 6.9 GB of `pg_wal` for about 600 000 published versions and
 * the box ran out of disk. `checkpoint.ts` states the rule measured on a scratch store —
 * a checkpoint after every 20 000 versions written keeps the directory at a few segments
 * (30 000 rows written with a checkpoint every 5 000 left it at 32 MB, 2 segments) — and
 * this test states the rule and that the statement is accepted where the store runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { CHECKPOINT_ROWS, CHECKPOINT_SQL } from '../src/graph/checkpoint.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { ensureGraphSchema, staticUnitPublicationOf } from '../src/fill/stages/static-graph.js';

let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;

beforeAll(async () => {
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await ensureGraphSchema(store);
}, 300_000);

afterAll(async () => {
  await owner?.close();
}, 300_000);

describe('the WAL checkpoint', () => {
  test('the statement the store runs is CHECKPOINT, and PGlite accepts it', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    expect(CHECKPOINT_SQL).toBe('CHECKPOINT');
    await owner.run((tx) => tx.query(CHECKPOINT_SQL));
  }, 300_000);

  test('a publication counts the versions it wrote, and a checkpoint is due at the bound and not before', async () => {
    if (store === undefined) throw new Error('the store was not opened');
    const writes = Array.from({ length: 7 }, (_, index) => {
      const key = `code.callable:shop:src/c.ts@${String(index)}:${String(index + 1)}:identifier`;
      return { kind: 'node' as const, evidence: 'e', value: { key, kind: 'code.callable', label: 'callable', properties: { recordKey: key, file: 'src/c.ts' } } };
    });
    await store.publishUnit(staticUnitPublicationOf({ unitId: 'file:shop:src/c.ts', stageId: 'code-facts', digest: 'd'.repeat(64), writes }));
    // The publication counted its seven versions toward the next checkpoint, which is not due yet.
    expect(store.checkpoints.written).toBe(7);
    expect((await store.maintain()).checkpoint).toBeNull();
    store.checkpoints.note(CHECKPOINT_ROWS - 7 - 1);
    expect((await store.maintain()).checkpoint).toBeNull();
    store.checkpoints.note(1);
    const due = (await store.maintain()).checkpoint;
    expect(due).not.toBeNull();
    expect(due!.written).toBe(CHECKPOINT_ROWS);
    expect(due!.ms).toBeGreaterThanOrEqual(0);
  }, 300_000);
});
