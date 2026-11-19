import { expect, test } from 'bun:test';
import { repositoryContract, repositoryManifest } from './repository-contract-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { pluginTurnAuthority, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import type { PluginLockEntry } from '../src/plugin/lock.js';

test('plugin publication derives authority from installed declarations, not draft labels', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: repositoryContract });
  const locks = new Map<string, PluginLockEntry>([['disk', { id: 'disk', version: '1.0.0', path: 'plugins/disk', line: 1, closure: 'a'.repeat(64) }]]);
  const wiring = { owner, contract: repositoryContract, manifest: repositoryManifest, locks, productFolder: '/fixture' } as unknown as PluginTurnWiring;
  try {
    const authority = pluginTurnAuthority(wiring, 'disk:code.repository');
    if (authority === undefined) throw new Error('a declared plugin turn requires authority');
    const first = await owner.transaction('write', async tx => await startupBinding(tx, repositoryContract, authority.sourceName, authority.permissions));
    locks.set('disk', { id: 'disk', version: '2.0.0', path: 'plugins/disk', line: 1, closure: 'b'.repeat(64) });
    const newer = pluginTurnAuthority(wiring, 'disk:code.repository');
    if (newer === undefined) throw new Error('a declared plugin turn requires authority');
    expect(newer.version).toBe('2.0.0');
    const second = await owner.transaction('write', async tx => await startupBinding(tx, repositoryContract, newer.sourceName, newer.permissions));
    expect(second.binding.sourceUid).toBe(first.binding.sourceUid);
    await owner.transaction('write', async tx => {
      const installed = await startupBinding(tx, repositoryContract, newer.sourceName, newer.permissions);
      await publishGraphDrafts(tx, installed.contract, { vertices: [{ kind: 'code.repository', key: { name: 'fixture' }, values: {}, producer: 'forged', producerVersion: 'forged' }], removals: [] });
    });
    const records = await owner.transaction('snapshot', async tx => await readKindAssertions(tx, 'vertex', 'code.repository', [], { contract: repositoryContract }));
    expect(records).toHaveLength(1);
    expect(records[0]!.activeSources).toEqual([first.binding.sourceUid]);
    expect(() => pluginTurnAuthority(wiring, 'forged:code.repository')).toThrow('names a plugin or a kind');
  } finally { await owner.close(); }
}, 30000);
