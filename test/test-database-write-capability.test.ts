/**
 * The fixture's write capability (test/test-database.ts, ALX-464 root R4): a case's write transaction is served by a
 * capability the fixture took for the store, never by rows the transaction itself wrote. A capability written inside the
 * transaction leaves deferred trigger events on `node`, `edge`, `assertion` and `context`, and a later `CREATE INDEX` of
 * the same transaction is then refused ("cannot CREATE INDEX \"node\" because it has pending trigger events", SQLSTATE
 * 55006). The product prepares a store's schema before any capability exists at all, and the fixture now does the same.
 */
import { expect, test } from 'bun:test';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { requireWriteCapability } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';
import { TEST_SOURCE_UID } from './write-capability-fixture.js';

/** A contract no run's template holds, so a store that takes it installs its DDL here. */
const graph: GraphContract = {
  vertex: [{
    name: 'probe.note',
    table: generatedTableName('probe.note', 'vertex'),
    key: ['name'],
    fields: [{ name: 'name', type: 'text' }, { name: 'body', type: 'text' }],
    capability: 'fixture',
  }],
  edge: [],
  dictionary: [],
};

test('a write transaction prepares a graph contract its store did not hold, and no capability row is pending behind it', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    // The store opened with the empty contract's schema; this transaction installs the probe contract's DDL, `CREATE
    // INDEX` over the graph's own tables included.
    expect(await prepareStore(owner, { contract: graph })).toEqual({ reset: false });
    const installed = await owner.run((tx) => tx.query<{ held: string | null }>('SELECT to_regclass($1)::text AS held', [assertionValueTableName('probe.note', 'vertex', 'body')]));
    expect(installed.rows[0]?.held).toBe(assertionValueTableName('probe.note', 'vertex', 'body'));
    // The capability still serves the transaction that writes the graph, whatever the transaction before it prepared.
    const source = await owner.transaction('write', async (tx) => requireWriteCapability(tx).sourceUid);
    expect(source).toBe(TEST_SOURCE_UID);
  } finally { await owner.close(); }
}, 60_000);

test('the write capability is taken once, at the store first write transaction, not at every one', async () => {
  const owner = await createTestDatabaseOwner();
  const operations = async (): Promise<string> => (await owner.run((tx) => tx.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.operation'"))).rows[0]!.count;
  try {
    expect(await operations()).toBe('0');
    await owner.transaction('write', async (tx) => { expect(requireWriteCapability(tx).sourceUid).toBe(TEST_SOURCE_UID); });
    await owner.transaction('write', async (tx) => { expect(requireWriteCapability(tx).sourceUid).toBe(TEST_SOURCE_UID); });
    expect(await operations()).toBe('1');
  } finally { await owner.close(); }
}, 60_000);
