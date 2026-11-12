import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

const table = generatedTableName('fixture.page', 'vertex');
const contract: GraphContract = {
  vertex: [{ name: 'fixture.page', table, capability: 'fixture', key: ['slug'], fields: [{ name: 'slug', type: 'text' }, { name: 'body', type: 'text' }] }],
  edge: [], dictionary: [],
};
const generated = new Map([['fixture.page', { kind: 'fixture.page', table, key: ['slug'], columns: ['body'], types: { body: 'text' as const } }]]);

test('generated pages count before the cursor, preserve empty totals, and read page membership in one statement', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', (tx) => publishGraphDrafts(tx, contract, {
      vertices: ['Alpha', 'Beta', 'Zulu', 'removed'].map((slug) => ({ kind: 'fixture.page', key: { slug }, values: { body: `body ${slug}` }, producer: 'fixture', producerVersion: '1' })),
      removals: [],
    }));
    await owner.exec("UPDATE node SET removed = true WHERE key->>'slug' = 'removed'");
    await owner.transaction('snapshot', async (tx) => {
      const statements: string[] = [];
      const measured = { query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        statements.push(sql);
        return await tx.query<Row>(sql, values);
      } };
      const reader = new GraphReader(owner, () => 'now', undefined, measured, undefined, generated);
      const first = await reader.list('fixture.page', { limit: 1 });
      expect(first.rows.map((entity) => entity.key)).toEqual(['fixture.page:Alpha']);
      expect(first.rows[0]?.properties['body']).toBe('body Alpha');
      expect(first.next).toBe('fixture.page:Alpha');
      expect(first.total).toBe(3);
      // Membership and total share a statement; only the selected page's opinions are read separately.
      expect(statements.length).toBe(2);
      statements.length = 0;
      const rest = await reader.list('fixture.page', { limit: 5, after: first.next! });
      expect(rest.rows.map((entity) => entity.key)).toEqual(['fixture.page:Beta', 'fixture.page:Zulu']);
      expect(rest.total).toBe(3);
      expect(rest.next).toBeNull();
      const searched = await reader.list('fixture.page', { limit: 1, q: '  ALp  ' });
      expect(searched.rows.map((entity) => entity.key)).toEqual(['fixture.page:Alpha']);
      expect(searched.total).toBe(1);
      expect(searched.next).toBeNull();
      statements.length = 0;
      const exhausted = await reader.list('fixture.page', { limit: 1, after: 'fixture.page:Zulu' });
      expect(exhausted).toEqual({ rows: [], next: null, total: 3 });
      expect(statements.length).toBe(1);
      statements.length = 0;
      expect(await reader.list('fixture.page', { limit: 1, q: 'no match' })).toEqual({ rows: [], next: null, total: 0 });
      expect(statements.length).toBe(1);
    });
  } finally { await owner.close(); }
});
