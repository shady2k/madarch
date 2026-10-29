/**
 * A publication resolves every edge identity it needs before writing, so two
 * publications that both saw one key hash absent must agree on the identity
 * one of them wrote (madarch-alzf review, RARE: concurrent publications and
 * `ON CONFLICT DO NOTHING`). The fake transaction is the overlap: the first
 * lookup is empty and the concurrent writer's row appears before the insert.
 */
import { describe, expect, test } from 'bun:test';
import { edgeIdentities, writeMemo, type WriteContext } from '../src/graph/versions.js';

describe('edge identities under concurrent publications', () => {
  test('a conflicting identity insert rereads the row the other publication wrote', async () => {
    const keyHash = 'concurrent-key-hash';
    const held = new Map([[keyHash, '7']]);
    let inserted = false;
    const query = async <Row extends object>(sql: string, _values?: readonly unknown[]) => {
      if (sql.startsWith('SELECT id::text AS id, key_hash FROM edge_identity')) {
        return { rows: (inserted ? [...held.entries()].map(([key_hash, id]) => ({ key_hash, id })) : []) as unknown as Row[] };
      }
      if (sql.startsWith('SELECT nextval')) return { rows: [{ id: '10' }] as unknown as Row[] };
      if (sql.startsWith('INSERT INTO edge_identity')) {
        if (!sql.includes('ON CONFLICT (key_hash) DO NOTHING')) throw new Error('duplicate key value violates unique constraint "edge_identity_key_hash_key"');
        inserted = true;
        return { rows: [] as Row[] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    };
    const ctx = { tx: { query }, at: '2026-01-02T00:00:00Z', now: () => '2026-01-02T00:00:00Z', memo: writeMemo() } satisfies WriteContext;
    await edgeIdentities(ctx, [keyHash]);
    expect(ctx.memo.edges.get(keyHash)).toBe('7');
  });
});
