/**
 * A store opened after its contract gained columns (madarch-8bdc.2.24): the stamp names every opinion field, so a
 * nullable field added to a vertex, an edge or a dictionary moves it, the table is reconciled in place, and the next
 * publication and page read see the column. A contract that changed nothing keeps the one-query fast path.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { GraphContract } from '../src/graph/contract.js';
import { generatedTableName } from '../src/graph/contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-schema-reconcile-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const table = generatedTableName('fixture.table', 'vertex');
const edgeTable = generatedTableName('fixture.edge', 'edge');
const dictionary = generatedTableName('fixture.dict', 'dictionary');

/** The contract before the nullable fields: one vertex kind, one edge kind, one dictionary. */
function contractBefore(): GraphContract {
  return {
    vertex: [{ name: 'fixture.table', table, capability: 'fixture', key: ['name'], fields: [
      { name: 'name', type: 'text' },
      { name: 'label', type: 'text', nullable: true },
    ] }],
    edge: [{ name: 'fixture.edge', table: edgeTable, from: ['fixture.table'], to: ['fixture.table'], repeats: true, discriminator: 'kind', capability: 'fixture', fields: [
      { name: 'weight', type: 'integer', nullable: true },
    ] }],
    dictionary: [{ name: 'fixture.dict', key: ['name'], fields: [{ name: 'name', type: 'text' }] }],
  };
}

/** The same contract with a nullable field on each of the three tables. */
function contractAfter(): GraphContract {
  const before = contractBefore();
  return {
    vertex: before.vertex.map((kind) => ({ ...kind, fields: [...kind.fields, { name: 'unsupported', type: 'boolean', nullable: true }] })),
    edge: before.edge.map((kind) => ({ ...kind, fields: [...kind.fields, { name: 'note', type: 'text', nullable: true }] })),
    dictionary: before.dictionary.map((one) => ({ ...one, fields: [...one.fields, { name: 'extra', type: 'text', nullable: true }] })),
  };
}

/** One owner wrapped to count the statements the schema opening makes, never to change what it answers. */
function counted(owner: DatabaseOwner): { readonly owner: DatabaseOwner; readonly queries: () => number } {
  let queries = 0;
  const wrapped = new Proxy(owner, {
    get(target, key) {
      if (key === 'transaction') {
        return async (kind: string, work: (tx: never) => Promise<unknown>) => await target.transaction(kind as never, async (tx) => work(new Proxy(tx, {
          get(txTarget, txKey) {
            if (txKey === 'query') return async (...args: unknown[]) => { queries += 1; return await (txTarget.query as (...one: unknown[]) => Promise<unknown>)(...args); };
            const value = Reflect.get(txTarget, txKey);
            return typeof value === 'function' ? value.bind(txTarget) : value;
          },
        }) as never));
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DatabaseOwner;
  return { owner: wrapped, queries: () => queries };
}

describe('a store reopened after its contract gained a nullable field', () => {
  test('reconciles the vertex, edge and dictionary columns, keeps the opinions, and keeps the fast path when nothing moved', async () => {
    const store = join(root, 'store');
    const first = await createTestDatabaseOwner({ store, btreeGist: true });
    try {
      expect(await createOneGraphSchema(first, contractBefore())).toEqual({ reset: true });
      await first.transaction('write', async (tx) => await publishGraphDrafts(tx, contractBefore(), {
        vertices: [
          { kind: 'fixture.table', key: { name: 'a' }, values: { label: 'first' }, producer: 'fixture', producerVersion: '1' },
          { kind: 'fixture.table', key: { name: 'b' }, values: { label: 'second' }, producer: 'fixture', producerVersion: '1' },
        ],
        edges: [{ kind: 'fixture.edge', from: { kind: 'fixture.table', key: { name: 'a' } }, to: { kind: 'fixture.table', key: { name: 'b' } }, discriminator: 'one', values: { weight: 2 }, producer: 'fixture', producerVersion: '1' }],
        removals: [],
      }, 1));
    } finally { await first.close(); }

    const changed = await createTestDatabaseOwner({ store, btreeGist: true });
    const changedCount = counted(changed);
    try {
      expect(await createOneGraphSchema(changedCount.owner, contractAfter())).toEqual({ reset: false });
      // The next publication writes the new vertex and edge columns; the old opinions stand.
      await changed.transaction('write', async (tx) => await publishGraphDrafts(tx, contractAfter(), {
        vertices: [{ kind: 'fixture.table', key: { name: 'a' }, values: { unsupported: false }, producer: 'fixture-2', producerVersion: '1' }],
        edges: [{ kind: 'fixture.edge', from: { kind: 'fixture.table', key: { name: 'a' } }, to: { kind: 'fixture.table', key: { name: 'b' } }, discriminator: 'one', values: { note: 'n' }, producer: 'fixture-2', producerVersion: '1' }],
        removals: [],
      }, 1));
      const reader = new GraphReader(changed, () => 'now', undefined, undefined, undefined, new Map([['fixture.table', {
        kind: 'fixture.table', table, columns: ['label', 'unsupported'], types: { label: 'text', unsupported: 'boolean' }, key: ['name'],
      }]]));
      const page = await reader.byPrefix('fixture.table', 'fixture.table:', 10);
      expect(page.rows.map((one) => [one.key, one.properties['label'], one.properties['unsupported']])).toEqual([
        ['fixture.table:a', 'first', false],
        ['fixture.table:b', 'second', undefined],
      ]);
      const columns = await changed.run(async (tx) => await tx.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND ((table_name = $1 AND column_name = 'unsupported') OR (table_name = $2 AND column_name = 'note') OR (table_name = $3 AND column_name = 'extra')) ORDER BY table_name, column_name`,
        [table, edgeTable, dictionary],
      ));
      expect(columns.rows).toEqual([
        { table_name: dictionary, column_name: 'extra' },
        { table_name: edgeTable, column_name: 'note' },
        { table_name: table, column_name: 'unsupported' },
      ]);
      const changedQueries = changedCount.queries();

      // The same contract again: the stamp stands and the opening is the short path.
      await changed.close();
      const same = await createTestDatabaseOwner({ store, btreeGist: true });
      const sameCount = counted(same);
      try {
        expect(await createOneGraphSchema(sameCount.owner, contractAfter())).toEqual({ reset: false });
        expect(sameCount.queries()).toBeLessThan(changedQueries);
        expect(sameCount.queries()).toBeLessThanOrEqual(10);
      } finally { await same.close(); }
    } finally {
      await changed.close().catch(() => undefined);
    }
  }, 120_000);
});
