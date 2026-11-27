import { expect, test } from 'bun:test';
import { EMPTY_CONTRACT, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { readKindAssertions } from '../src/graph/records.js';
import { newUid } from '../src/graph/uid.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

const producer = 'agent-fill';

test('overlapping agent-fill startups in one transaction reuse its installation', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'fixture'));
    const [first, second] = await owner.transaction('write', tx => Promise.all([
      startupBinding(tx, EMPTY_CONTRACT, producer),
      startupBinding(tx, EMPTY_CONTRACT, producer),
    ]));
    await owner.transaction('snapshot', async tx => {
      const operationUids = [first.binding.operationUid, second.binding.operationUid];
      const operations = await readKindAssertions(tx, 'vertex', 'system.operation', [], { subjectUids: operationUids });
      const plugins = await readKindAssertions(tx, 'vertex', 'plugin', ['label']);
      const authors = await readKindAssertions(tx, 'edge', 'system.operation-author', []);
      const installed = plugins.filter(plugin => plugin.values.label === producer);
      expect(installed.map(plugin => plugin.uid)).toEqual([first.binding.sourceUid]);
      expect(operations.map(operation => operation.uid).sort()).toEqual(operationUids.sort());
      for (const operation of operations) {
        expect(authors.filter(author => author.from === operation.id).map(author => author.to)).toEqual([installed[0]!.id]);
        expect(operation.selectedAssertions.find(assertion => assertion.property === '$exists')).toMatchObject({
          author: first.binding.sourceUid, operationUid: operation.uid,
        });
      }
    });
    // A different grant exercises discovery after commit even when the original grant is cached.
    const { binding: recovered } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, producer, []));
    expect(second.binding.sourceUid).toBe(first.binding.sourceUid);
    expect(second.binding.operationUid).not.toBe(first.binding.operationUid);
    expect(recovered.sourceUid).toBe(first.binding.sourceUid);
  } finally { await owner.close(); }
});

test.each(['plugin', 'system.unit'] as const)('a new %s remains active for operation publication if the database clock moves back', async endpoint => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    const unitUid = newUid();
    const { binding } = await owner.transaction('write', async tx => {
      // Simulate a clock correction after BEGIN without moving the shared server clock.
      await tx.query('CREATE SCHEMA test_clock');
      await tx.query(`CREATE FUNCTION test_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql
        AS $$ SELECT pg_catalog.transaction_timestamp() - interval '1 minute' $$`);
      const moveClockBack = async () => await tx.query('SET LOCAL search_path TO test_clock, pg_catalog, public');
      if (endpoint === 'plugin') await moveClockBack();
      const installed = await startupBinding(tx, EMPTY_CONTRACT, producer);
      const { operationUid, sourceUid, contractVersion } = installed.binding;
      const writer = { producer: sourceUid, producerVersion: contractVersion };
      await publishGraphDrafts(tx, installed.contract, {
        vertices: [{ kind: 'system.unit', uid: unitUid, key: {}, ...writer }], removals: [],
      });
      if (endpoint === 'system.unit') await moveClockBack();
      await publishGraphDrafts(tx, installed.contract, {
        vertices: [{ kind: 'system.operation', uid: operationUid, key: {}, ...writer }], removals: [], edges: [{
          kind: 'system.operation-unit', from: { kind: 'system.operation', uid: operationUid, key: {} },
          to: { kind: 'system.unit', uid: unitUid, key: {} }, ...writer,
        }],
      });
      return installed;
    });
    await owner.transaction('snapshot', async tx => {
      const [operation] = await readKindAssertions(tx, 'vertex', 'system.operation', [], { subjectUids: [binding.operationUid] });
      const [plugin] = await readKindAssertions(tx, 'vertex', 'plugin', ['label'], { subjectUids: [binding.sourceUid] });
      const [unit] = await readKindAssertions(tx, 'vertex', 'system.unit', [], { subjectUids: [unitUid] });
      expect(operation?.uid).toBe(binding.operationUid);
      expect(plugin?.values.label).toBe(producer);
      expect(unit?.uid).toBe(unitUid);
      const authors = await readKindAssertions(tx, 'edge', 'system.operation-author', []);
      const units = await readKindAssertions(tx, 'edge', 'system.operation-unit', []);
      expect(authors.filter(edge => edge.from === operation!.id).map(edge => edge.to)).toEqual([plugin!.id]);
      expect(units.filter(edge => edge.from === operation!.id).map(edge => edge.to)).toEqual([unit!.id]);
    });
  } finally { await owner.close(); }
});

test('an invalid startup contract leaves the next call on the transaction free to bind', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const invalid: GraphContract = {
    ...EMPTY_CONTRACT,
    vertex: [{
      name: 'fixture.invalid',
      table: generatedTableName('fixture.invalid', 'vertex'),
      capability: 'fixture',
      key: [],
      fields: [{ name: 'payload', type: 'json' }],
    }],
  };
  try {
    const [rejected, accepted] = await owner.transaction('write', tx => Promise.allSettled([
      startupBinding(tx, invalid, producer),
      startupBinding(tx, EMPTY_CONTRACT, producer),
    ]));
    expect(rejected.status === 'rejected' && rejected.reason.message).toContain('SCHEMA_INVALID fixture.invalid.payload');
    if (accepted.status === 'rejected') throw accepted.reason;
    const { binding } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, producer, []));
    expect(binding.sourceUid).toBe(accepted.value.binding.sourceUid);
  } finally { await owner.close(); }
});

test('agent-fill startups on different connections recover from a rolled-back installation', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const installed = Promise.withResolvers<{ pid: number; sourceUid: string }>();
  const waiting = Promise.withResolvers<void>();
  const rollback = new Error('roll back the first installation');
  try {
    const first = owner.transaction('write', async tx => {
      const { rows: [session] } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const { binding } = await startupBinding(tx, EMPTY_CONTRACT, producer);
      installed.resolve({ pid: session!.pid, sourceUid: binding.sourceUid });
      await waiting.promise;
      throw rollback;
    }).catch(error => {
      installed.reject(error);
      return error;
    });
    const second = owner.transaction('write', async tx => {
      const { rows: [session] } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const previous = await installed.promise;
      const pending = startupBinding(tx, EMPTY_CONTRACT, producer);
      waiting.resolve();
      return { previous, pid: session!.pid, binding: (await pending).binding };
    }).finally(() => waiting.resolve());
    const [failure, recovered] = await Promise.all([first, second]);
    expect(failure).toBe(rollback);
    expect(recovered.pid).not.toBe(recovered.previous.pid);
    expect(recovered.binding.sourceUid).not.toBe(recovered.previous.sourceUid);

    const following = await Promise.all([undefined, [] as const].map(permissions =>
      owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, producer, permissions))));
    expect(following.map(result => result.binding.sourceUid)).toEqual([recovered.binding.sourceUid, recovered.binding.sourceUid]);
  } finally { await owner.close(); }
});
