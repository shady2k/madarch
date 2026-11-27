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
  vertex: kinds.map(name => ({ name, table: generatedTableName(name, 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'note', type: 'text' as const, nullable: true }], capability: 'fixture' })),
  edge: [],
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

test('a catalogue value lookup costs the same with one row and with twenty', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    await seed(owner, 1);
    const read = async (): Promise<string[]> => {
      const { owner: counted, statements } = counting(owner);
      expect(await pluginGraphValue(counted, contract, 'alpha', { name: 'alpha-0' }, 'note')).toBe('alpha 0');
      return statements;
    };
    const single = await read();
    await seed(owner, 19);
    const many = await read();
    expect(many).toHaveLength(single.length);
  } finally { await owner.close(); }
}, 60_000);
