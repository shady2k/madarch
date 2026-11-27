/**
 * A store binds its writer once (madarch-64o5.176, F2). The installation of a producer — the product
 * it stands in, the plugin it publishes and the rights it writes under — is discovered from the graph
 * once and remembered while the store stands, so a process's transactions bind from what it already
 * installed instead of rebuilding the rights from the graph on every one. What is remembered is still
 * checked, and a store that lost it — a start over replaced the schema — is discovered again.
 */
import { expect, test } from 'bun:test';
import { EMPTY_CONTRACT, type GraphContract } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { createTestDatabaseOwner, prepareTestStore, type TestDatabaseOwner } from './test-database.js';

const contract = withAssertionContract(EMPTY_CONTRACT);
/** The installation's own lock: 739141, taken once for the discovery and not again for a remembered one. */
const INSTALLATION_LOCK = 739141;

/** The owner, with every statement the bindings make counted by what it is. */
function countedOwner(owner: TestDatabaseOwner): { readonly owner: TestDatabaseOwner; readonly discovery: () => number; readonly locks: () => number; readonly reset: () => void } {
  let discovery = 0;
  let locks = 0;
  const counting = Object.create(owner) as TestDatabaseOwner;
  counting.transaction = async (kind, work) => await owner.transaction(kind, async tx => {
    const query = tx.query.bind(tx);
    tx.query = async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes("k.name IN ('system.product','plugin')")) discovery += 1;
      if (values?.[0] === INSTALLATION_LOCK) locks += 1;
      return await query<Row>(sql, values);
    };
    return await work(tx);
  });
  return { owner: counting, discovery: () => discovery, locks: () => locks, reset: () => { discovery = 0; locks = 0; } };
}

const bind = async (database: TestDatabaseOwner, declared: GraphContract = contract, producer = 'probe') =>
  await database.transaction('write', async tx => await startupBinding(tx, declared, producer));

test('repeated transactions bind the installation the store already holds, without reading it again', async () => {
  const counted = countedOwner(await createTestDatabaseOwner());
  try {
    const first = await bind(counted.owner);
    expect(counted.discovery()).toBe(1);
    expect(counted.locks()).toBe(1);
    counted.reset();
    const second = await bind(counted.owner);
    const third = await bind(counted.owner);
    // The installation is not read again, and its lock is not taken again: both transactions bind from what
    // the first one installed. The identities are the store's, and each transaction is still its own operation.
    expect(counted.discovery()).toBe(0);
    expect(counted.locks()).toBe(0);
    expect(second.binding.productUid).toBe(first.binding.productUid);
    expect(second.binding.sourceUid).toBe(first.binding.sourceUid);
    expect(third.binding.productUid).toBe(first.binding.productUid);
    expect(second.binding.operationUid).not.toBe(first.binding.operationUid);
    expect(third.binding.operationUid).not.toBe(second.binding.operationUid);
    expect(third.contract).toEqual(first.contract);
  } finally { await counted.owner.close(); }
}, 60_000);

test('a store replaced under the process is discovered again rather than bound from what it held', async () => {
  const counted = countedOwner(await createTestDatabaseOwner());
  try {
    const before = await bind(counted.owner);
    counted.reset();
    await prepareTestStore(counted.owner, { reset: true });
    const after = await bind(counted.owner);
    expect(counted.discovery()).toBe(1);
    // The schema was replaced, so the store names another product: the identity of the one before it is gone.
    expect(after.binding.productUid).not.toBe(before.binding.productUid);
    // And what it bound writes: the new store's plugin stands, as the kind the binding names.
    const kinds = await counted.owner.run(async tx => (await tx.query<{ kind: string }>('SELECT k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid', [after.binding.sourceUid])).rows);
    expect(kinds.map(row => row.kind)).toEqual(['plugin']);
  } finally { await counted.owner.close(); }
}, 60_000);

test('a publication of other declarations binds its own installation under the same producer', async () => {
  const counted = countedOwner(await createTestDatabaseOwner());
  try {
    const whole = await bind(counted.owner);
    counted.reset();
    await bind(counted.owner);
    expect(counted.discovery()).toBe(0);
    // A changed catalogue is another contract revision: its writes are granted against its own declarations,
    // so it is discovered rather than bound with the rights the earlier revision was granted.
    const other = withAssertionContract({ ...EMPTY_CONTRACT, vertex: [...EMPTY_CONTRACT.vertex, { name: 'probe.kind', fields: [], identity: undefined }] } as GraphContract);
    const changed = await bind(counted.owner, other);
    expect(counted.discovery()).toBe(1);
    expect(changed.binding.contractVersion).not.toBe(whole.binding.contractVersion);
    // One producer publishes one plugin: the declarations changed, the installation did not.
    expect(changed.binding.sourceUid).toBe(whole.binding.sourceUid);
    expect(changed.binding.productUid).toBe(whole.binding.productUid);
  } finally { await counted.owner.close(); }
}, 60_000);
