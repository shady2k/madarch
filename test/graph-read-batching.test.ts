/**
 * The reads a fill's turn makes are one statement per question, not one per kind, row or key (decision 0035 item 15,
 * decision 0039 item 25): a plugin's facts, its catalogue lookups and its key-edge references are batched, so the
 * number of statements depends on the shape of the question, never on how much the graph holds.
 */
import { expect, test } from 'bun:test';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { pluginGraphValue } from '../src/graph/plugin-turns.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';

const kinds = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const contract: GraphContract = {
  vertex: [
    ...kinds.map(name => ({ name, table: generatedTableName(name, 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'note', type: 'text' as const, nullable: true }], capability: 'fixture' })),
    // A kind whose key is not unique on its own: two notes may carry one name under two owners, and only the key
    // edge tells them apart.
    { name: 'note', table: generatedTableName('note', 'vertex'), key: ['name'], keyEdges: [{ role: 'owner', edge: 'owns', direction: 'from' as const, onDelete: 'restrict' as const }], fields: [{ name: 'name', type: 'text' as const }, { name: 'note', type: 'text' as const, nullable: true }], capability: 'fixture' },
    { name: 'owner', table: generatedTableName('owner', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' as const }], capability: 'fixture' },
  ],
  edge: [{ name: 'owns', table: generatedTableName('owns', 'edge'), from: ['note'], to: ['owner'], fields: [], repeats: false, cardinality: { from: 'many' as const, to: 'one' as const }, labels: { en: { out: 'owned by', in: 'owns' }, ru: { out: 'owned by', in: 'owns' } }, capability: 'fixture' }],
  dictionary: [],
};

/** An owner that runs the same work and remembers every statement the work issued. */
function counting(owner: DatabaseOwner): { owner: DatabaseOwner; statements: string[] } {
  const statements: string[] = [];
  return { statements, owner: {
    transaction: async <Result>(kind: 'write' | 'snapshot', work: (tx: SqlExecutor) => Promise<Result>): Promise<Result> =>
      await owner.transaction(kind, async tx => await work({ query: async <Row extends object>(sql: string, parameters?: readonly unknown[]) => { statements.push(sql); return await tx.query<Row>(sql, parameters); } })),
  } as unknown as DatabaseOwner };
}

const seed = async (owner: DatabaseOwner, perKind: number): Promise<void> => await owner.transaction('write', async tx => {
  await bindTestWriteCapability(tx, contract);
  for (const name of kinds) {
    await publishGraphDrafts(tx, contract, { vertices: Array.from({ length: perKind }, (_, index) => ({ kind: name, key: { name: `${name}-${String(index)}` }, values: { note: `${name} ${String(index)}` }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })), removals: [] });
  }
});

/** One note under each of the given owners, all of them carrying the same name. */
const notes = async (owner: DatabaseOwner, owners: readonly number[]): Promise<void> => await owner.transaction('write', async tx => {
  await bindTestWriteCapability(tx, contract);
  const held = owners.map(index => ({ kind: 'owner', key: { name: `owner-${String(index)}` } }));
  await publishGraphDrafts(tx, contract, {
    vertices: [
      ...held.map(ref => ({ ...ref, producer: 'fixture', producerVersion: '1' })),
      ...owners.map((index, position) => ({ kind: 'note', key: { name: 'note-0' }, keyEdges: { owner: held[position]! }, values: { note: `note ${String(index)}` }, producer: 'fixture', producerVersion: '1' })),
    ],
    removals: [],
  });
});

test('a producer facts read answers every kind in one assertion statement', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    await seed(owner, 2);
    const read = async (requested: readonly string[]): Promise<string[]> => {
      const { owner: counted, statements } = counting(owner);
      const facts = await producerFacts(counted, contract, '019a0000-0000-7000-8000-000000000002', requested, []);
      expect(facts.vertices.length).toBeGreaterThan(0);
      return statements;
    };
    const two = await read(kinds.slice(0, 2));
    const all = await read(kinds);
    const valueTables = kinds.map(name => assertionValueTableName(name, 'vertex', 'note'));
    // One statement carries both kinds' typed values: the batch is the statement, not the loop.
    expect(two.filter(sql => sql.includes(valueTables[0]!) && sql.includes(valueTables[1]!))).toHaveLength(1);
    expect(all.filter(sql => sql.includes(valueTables[0]!) && sql.includes(valueTables[5]!))).toHaveLength(1);
    // The same kinds with more rows answer in the same number of statements.
    await seed(owner, 18);
    expect(await read(kinds)).toHaveLength(all.length);
  } finally { await owner.close(); }
}, 60_000);

test('a catalogue value lookup costs the same with two candidates of one key and with twenty', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    await notes(owner, [0, 1]);
    const read = async (): Promise<string[]> => {
      const { owner: counted, statements } = counting(owner);
      // Both candidates carry the name `note-0`; the owner edge chooses, so every candidate's key edge is read.
      expect(await pluginGraphValue(counted, contract, 'note', { name: 'note-0' }, 'note', { owner: { kind: 'owner', key: { name: 'owner-1' } } })).toBe('note 1');
      return statements;
    };
    const two = await read();
    // One statement for the rows and one for their key edges, whatever the number of candidates.
    expect(two.filter(sql => sql.includes('WITH batches AS MATERIALIZED'))).toHaveLength(2);
    await notes(owner, Array.from({ length: 18 }, (_, index) => index + 2));
    const many = await read();
    expect(many).toHaveLength(two.length);
  } finally { await owner.close(); }
}, 60_000);
