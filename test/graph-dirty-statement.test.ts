/**
 * The change-accounting trigger runs once per statement (decision 0039 item 28): the same least id, the same set of
 * value tables and the same revision count a row trigger left, read from the rows the statement inserted. A
 * statement that inserts no row changes nothing, and a check that ran inside the statement — immediate constraints
 * fire it before the statement's own rows are accounted — is repeated once the accounting stands.
 */
import { expect, test } from 'bun:test';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';

const contract: GraphContract = {
  vertex: [{ name: 'ledger', table: generatedTableName('ledger', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'amount', type: 'bigint' as const, nullable: true }], capability: 'fixture' }],
  edge: [],
  dictionary: [],
};
const names = ['first', 'second', 'third'];
const valueTable = assertionValueTableName('ledger', 'vertex', 'amount');
const ids = [9001, 9002, 9003];

interface Settings { readonly [key: string]: unknown; node_lower: string | null; edge_lower: string | null; context_lower: string | null; value_tables: string | null; revision: string | null }
const settings = async (tx: SqlExecutor): Promise<Settings> => (await tx.query<Settings>(
  `SELECT current_setting('madarch.graph_node_lower',true) AS node_lower,current_setting('madarch.graph_edge_lower',true) AS edge_lower,
     current_setting('madarch.graph_context_lower',true) AS context_lower,current_setting('madarch.graph_value_tables',true) AS value_tables,
     current_setting('madarch.graph_revision',true) AS revision`)).rows[0]!;

/** The rows of each accounted table, written explicitly so both runs insert the same identities. */
const nodeRow = (id: number): string => `(${String(id)},(SELECT id FROM entity WHERE name='ledger'),gen_random_uuid(),gen_random_uuid())`;
const edgeRow = (id: number): string => `(${String(id)},gen_random_uuid(),(SELECT id FROM entity WHERE name='system.assertion-source'),(SELECT min(id) FROM node WHERE entity_id=(SELECT id FROM entity WHERE name='ledger')),(SELECT max(id) FROM node WHERE entity_id=(SELECT id FROM entity WHERE name='ledger')),${String(id)})`;
const valueRow = (id: number, index: number): string => `((SELECT assertion_id FROM assertion ORDER BY assertion_id OFFSET ${String(index)} LIMIT 1),${String(id)})`;
/** One statement per table for the given identities: the batch hands it all of them, the row variant one at a time. */
const inserts = (group: readonly number[]): readonly string[] => {
  const offset = (id: number): number => ids.indexOf(id);
  return [
    `INSERT INTO node(id,entity_id,uid,identity_scope) OVERRIDING SYSTEM VALUE VALUES ${group.map(nodeRow).join(',')}`,
    `INSERT INTO edge(id,uid,entity_id,from_node,to_node,discriminator) OVERRIDING SYSTEM VALUE VALUES ${group.map(edgeRow).join(',')}`,
    `INSERT INTO "${valueTable}"(assertion_id,value) VALUES ${group.map(id => valueRow(id, offset(id))).join(',')}`,
  ];
};

test('a batch accounts exactly what the same rows inserted one by one accounted', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    const lowestAssertion = await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: names.map(name => ({ kind: 'ledger', key: { name }, values: { amount: 1 }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })), removals: [] });
      return (await tx.query<{ id: string }>('SELECT min(assertion_id)::text AS id FROM (SELECT assertion_id FROM assertion ORDER BY assertion_id LIMIT 3) held')).rows[0]!.id;
    });
    // Both runs insert the same rows and are discarded, so each one is measured from the same graph.
    const measure = async (batched: boolean): Promise<Settings> => {
      let measured: Settings | undefined;
      await expect(owner.transaction('write', async tx => {
        for (const statement of batched ? inserts(ids) : ids.flatMap(id => inserts([id]))) await tx.query(statement);
        measured = await settings(tx);
        throw new Error('discard the measured rows');
      })).rejects.toThrow('discard the measured rows');
      return measured!;
    };
    const batched = await measure(true);
    const sequential = await measure(false);
    // An assertion is a node: the node bound is the least of the node ids and the assertion ids the rows carried.
    expect(batched.node_lower).toBe(String(Math.min(ids[0]!, Number(lowestAssertion))));
    expect(batched.edge_lower).toBe(String(ids[0]));
    expect(batched.context_lower).toBe(sequential.context_lower);
    expect(JSON.parse(batched.value_tables ?? '{}')).toEqual({ [valueTable]: true });
    expect(Number(batched.revision)).toBe(9);
    expect(sequential).toEqual(batched);
  } finally { await owner.close(); }
}, 60_000);

test('a statement that inserts no row leaves the accounting of the statement before it alone', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: names.map(name => ({ kind: 'ledger', key: { name }, values: { amount: 1 }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })), removals: [] });
      const before = await settings(tx);
      await tx.query(`INSERT INTO "${valueTable}"(assertion_id,value) SELECT assertion_id,1 FROM assertion WHERE false`);
      await tx.query(`INSERT INTO node(entity_id,uid,identity_scope) SELECT entity_id,gen_random_uuid(),identity_scope FROM node WHERE false`);
      expect(await settings(tx)).toEqual(before);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  } finally { await owner.close(); }
}, 60_000);
