/**
 * A store that holds values for a field a contract no longer declares still opens (owner's rule, 2026-11-13): a page's
 * `mentions` values become `mentions` edges, and anything else closes with a journal entry. No store refuses to open.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { prepareGraphSchema } from '../src/adapters/schemas/graph.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

const table = generatedTableName('demo.page', 'vertex');
const mentionsTable = generatedTableName('mentions', 'edge');
const oldContract: GraphContract = {
  vertex: [{ name: 'demo.page', table, key: ['title'], capability: 'agent', fields: [{ name: 'title', type: 'text' }, { name: 'mentions', type: 'json', nullable: true }, { name: 'legacy', type: 'json', nullable: true }] }],
  edge: [], dictionary: [],
};
const newContract: GraphContract = {
  vertex: [{ name: 'demo.page', table, key: ['title'], capability: 'agent', fields: [{ name: 'title', type: 'text' }] }],
  edge: [{ name: 'mentions', table: mentionsTable, from: ['any'], to: ['any'], repeats: true, discriminator: 'place', fields: [], capability: 'manifest' }],
  dictionary: [],
};

describe('a populated field a contract removes', () => {
  let owner: DatabaseOwner | undefined;
  afterAll(async () => { await owner?.close(); });

  test('its mentions become mentions edges, and another removed value closes with a journal entry', async () => {
    owner = await createTestDatabaseOwner({ graphContract: oldContract });
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, oldContract, {
        vertices: [
          { kind: 'demo.page', key: { title: 'target' }, values: {}, producer: 'agent', producerVersion: '1' },
          { kind: 'demo.page', key: { title: 'source' }, values: { legacy: { note: 'old value' } }, producer: 'agent', producerVersion: '1' },
        ],
        removals: [],
      }, 1, { author: 'agent@1' });
    });
    const target = await owner.run(async (tx) => (await tx.query<{ uid: string }>(`SELECT n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'demo.page' AND n.key->>'title' = 'target'`)).rows[0]!.uid);
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, oldContract, {
        vertices: [{ kind: 'demo.page', key: { title: 'source' }, values: { mentions: [target] }, producer: 'agent', producerVersion: '1' }],
        removals: [],
      }, 1, { author: 'agent@1' });
    });
    await prepareGraphSchema(owner, newContract);
    const columns = await owner.run(async (tx) => (await tx.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table])).rows.map((row) => row.column_name));
    expect(columns).not.toContain('mentions');
    expect(columns).not.toContain('legacy');
    const edges = await owner.run(async (tx) => (await tx.query<{ discriminator: string; to_node: string }>(`SELECT e.discriminator, e.to_node::text AS to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = 'mentions'`)).rows);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.discriminator).toStartWith('migrated:');
    const opinions = await owner.run(async (tx) => (await tx.query<{ said_by: string }>(`SELECT said_by FROM ${mentionsTable}`)).rows);
    expect(opinions.map((row) => row.said_by)).toEqual(['migration@1']);
    const journal = await owner.run(async (tx) => (await tx.query<{ author: string; words: string }>(`SELECT author, words FROM operation WHERE author = 'migration@1' ORDER BY seq`)).rows);
    expect(journal.length).toBeGreaterThanOrEqual(2);
    expect(journal.some((row) => row.words.includes('mentions edges'))).toBe(true);
    expect(journal.some((row) => row.words.includes('closed'))).toBe(true);
  }, 60_000);
});
