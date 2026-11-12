import { withManifestContract } from '../src/graph/manifest-contract.js';
import { expect, test } from 'bun:test';
import { createRecordSchema, publishHistory, publishTree } from '../src/graph/records.js';
import { GIT_CONTRACT, GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { publishEdgeOpinion } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

// A whole-graph verdict reads every touched edge. Its cost must be one properties read, not one per changed file.
test('relation properties are batched without mixing edges, producers, contexts or closed opinions', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(GIT_CONTRACT) });
  try {
    await createRecordSchema(owner);
    const hash = 'a'.repeat(40);
    const paths = ['a.txt', 'b.txt', 'c.txt'];
    await publishTree(owner, {
      repository: { name: 'fixture', url: 'file:///fixture' }, commit: hash,
      files: paths.map((path) => ({ path, mode: '100644', blob: 'b'.repeat(40), bytes: 2, lines: 1, form: 'text' as const, language: 'Text', candidates: ['Text'], content: 'x\n' })),
      gitlinks: [],
    });
    await publishHistory(owner, {
      repository: { name: 'fixture' },
      commits: [{ hash, parents: [], authorName: 'Fixture', authorEmail: 'fixture@example.test', authorDate: '2026-01-01T00:00:00+00:00', commitDate: '2026-01-01T00:00:00+00:00', subject: 'fixture', touched: paths.map((path, at) => ({ path, change: 'added' as const, added: at + 1, removed: 0 })) }],
    });
    const edges = await owner.run(async (tx) => await tx.query<{ id: string; path: string }>(`SELECT e.id::text AS id, n.key->>'path' AS path FROM edge e JOIN entity k ON k.id = e.entity_id JOIN node n ON n.id = e.to_node WHERE k.name = $1 ORDER BY n.key->>'path'`, [GIT_KINDS.touched]));
    await owner.transaction('write', async (tx) => {
      await tx.query("INSERT INTO context (parent, ref) VALUES (1, 'review')");
      // Closing and replacing the first producer's value must not leak the old value into agreement.
      await publishEdgeOpinion(tx, GIT_CONTRACT, GIT_KINDS.touched, edges.rows[0]!.id, { producer: 'git-history', producerVersion: '1', values: { change: 'modified', added: 9, removed: 2 } });
      await publishEdgeOpinion(tx, GIT_CONTRACT, GIT_KINDS.touched, edges.rows[1]!.id, { producer: 'review', producerVersion: '1', values: { change: 'modified', added: 7, removed: 0 } });
      await publishEdgeOpinion(tx, GIT_CONTRACT, GIT_KINDS.touched, edges.rows[2]!.id, { producer: 'other-context', producerVersion: '1', values: { change: 'deleted', added: 99, removed: 99 } }, 2);
    });
    const reads: string[] = [];
    await owner.transaction('snapshot', async (tx) => {
      const measured = new Proxy(tx, { get(target, key) {
        if (key === 'query') return async (sql: string, values?: readonly unknown[]) => { reads.push(sql); return await target.query(sql, values); };
        return Reflect.get(target, key);
      } });
      const reader = new GraphReader(owner, () => '2026-01-02T00:00:00Z', undefined, measured);
      const result = await reader.relationEdges('code.touched', 100);
      expect(result.total).toBe(3);
      expect(result.rows.map((row) => [row.to.properties?.['path'], row.properties])).toEqual([
        ['a.txt', { change: 'modified', added: 9, removed: 2 }],
        ['b.txt', { change: ['added', 'modified'], added: Number.NaN, removed: 0 }],
        ['c.txt', { change: 'added', added: 3, removed: 0 }],
      ]);
      expect(result.rows.map((row) => row.discriminator)).toEqual(['', '', '']);
      expect(reads).toHaveLength(3);
      reads.length = 0;
      const declared = new GraphReader(owner, () => '2026-01-02T00:00:00Z', undefined, measured, undefined, undefined, new Map([
        [GIT_KINDS.touched, { kind: GIT_KINDS.touched, table: GIT_TABLES.touched, columns: ['change', 'added', 'removed'], types: { change: 'text', added: 'integer', removed: 'integer' }, from: ['commit'], to: ['file'] }],
      ]));
      const generated = await declared.relationEdges('code.touched', 2);
      expect(generated.total).toBe(3);
      expect(generated.rows.map((row) => row.properties)).toEqual([
        { change: 'modified', added: 9, removed: 2 },
        { change: ['added', 'modified'], added: [2, 7], removed: 0 },
      ]);
      expect(reads).toHaveLength(3);
      reads.length = 0;
      expect((await reader.relationEdges('code.touched', 0)).rows).toEqual([]);
      expect(reads).toHaveLength(2);
    });
  } finally { await owner.close(); }
}, 20_000);
