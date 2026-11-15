import { expect, test } from 'bun:test';
import { repositoryContract, repositoryManifest } from './repository-contract-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { withSystemContract } from '../src/graph/system-contract.js';
import { pluginTurnBinding } from '../src/fill/plugin-turns.js';
import { publishGraphWrites } from '../src/graph/claims.js';
import type { PluginLockEntry } from '../src/plugin/lock.js';

// The unit id is host plan data. Draft metadata cannot choose a different installed source.
test('plugin publication reconstructs the retained host source and refuses forged draft metadata', async () => {
  const contract = withSystemContract(repositoryContract);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const locks = new Map<string, PluginLockEntry>([['disk', { id: 'disk', version: '1.0.0', path: 'plugins/disk', line: 1, closure: 'a'.repeat(64) }]]);
  const wiring = { owner, contract, manifest: repositoryManifest, locks, productFolder: '/fixture' };
  try {
    const binding = await pluginTurnBinding(wiring, 'disk:code.file');
    const again = await pluginTurnBinding(wiring, 'disk:code.file');
    expect(again.sourceUid).toBe(binding.sourceUid);
    locks.set('disk', { id: 'disk', version: '2.0.0', path: 'plugins/disk', line: 1, closure: 'b'.repeat(64) });
    const upgraded = await pluginTurnBinding(wiring, 'disk:code.file');
    expect(upgraded.sourceUid).toBe(binding.sourceUid);
    expect(upgraded.version).toBe('2.0.0');
    const draft = { kind: 'vertex', value: { kind: 'code.file', key: { repository: 'fixture', path: 'one.ts' }, values: {}, selectedFields: [], producer: 'forged', producerVersion: upgraded.version } };
    await expect(owner.transaction('write', async tx => await publishGraphWrites(tx, contract, [draft], upgraded))).rejects.toThrow(/differs/);
    await expect(owner.transaction('write', async tx => await publishGraphWrites(tx, contract, [{ ...draft, value: { ...draft.value, producer: upgraded.producer, producerVersion: 'forged' } }], upgraded))).rejects.toThrow(/differs/);
    const after = await owner.transaction('snapshot', async tx => await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'code.file'`));
    expect(after.rows).toHaveLength(0);
    await owner.transaction('write', async tx => await publishGraphWrites(tx, contract, [{ ...draft, value: { ...draft.value, producer: upgraded.producer } }], upgraded));
    const accepted = await owner.transaction('snapshot', async tx => await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'code.file'`));
    expect(accepted.rows).toHaveLength(1);
    await expect(pluginTurnBinding(wiring, 'forged:code.file')).rejects.toThrow('names a plugin or a kind');
    await expect(owner.transaction('write', async tx => await publishGraphWrites(tx, contract, [draft], { ...upgraded }))).rejects.toThrow('host-issued source binding');
  } finally { await owner.close(); }
});
