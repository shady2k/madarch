import { expect, test } from 'bun:test';
import { EMPTY_CONTRACT, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
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
    // A different grant exercises discovery after commit even when the original grant is cached.
    const { binding: recovered } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, producer, []));
    expect(second.binding.sourceUid).toBe(first.binding.sourceUid);
    expect(second.binding.operationUid).not.toBe(first.binding.operationUid);
    expect(recovered.sourceUid).toBe(first.binding.sourceUid);
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
