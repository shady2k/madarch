import { expect, test } from 'bun:test';
import { repositoryContract, repositoryManifest } from './repository-contract-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { pluginGraphAnswerer, pluginTurnAuthority, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import type { PluginLockEntry } from '../src/plugin/lock.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { PluginGraphValueRequest } from '../src/plugin/protocol.js';
import { Value } from 'typebox/value';

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


test('plugin file reads return parent keys that can be sent back through the public graph protocol', async () => {
  const contract = withManifestContract(repositoryContract);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const repository = { kind: 'code.repository', key: { name: 'fixture' } };
  const keyEdges = { 'code.file-repository': repository };
  const file = { kind: 'code.file', key: { path: 'src/example.ts' }, keyEdges };
  const encode = (value: unknown): unknown => value instanceof Map
    ? { $map: [...value].map(([key, held]) => [key, encode(held)]) }
    : Array.isArray(value) ? value.map(encode)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([, held]) => held !== undefined).map(([key, held]) => [key, encode(held)]))
      : value;
  try {
    await owner.transaction('write', async tx => {
      await startupBinding(tx, contract, 'public-file-read-fixture');
      await publishGraphDrafts(tx, contract, { vertices: [
        { kind: 'manifest.catalogue', key: { name: 'product' }, values: { declaration: JSON.stringify(encode(repositoryManifest)) }, producer: 'fixture', producerVersion: '1' },
        { ...repository, values: {}, producer: 'fixture', producerVersion: '1' },
        { ...file, values: { language: 'typescript' }, producer: 'fixture', producerVersion: '1' },
      ], removals: [] });
    });
    const graph = pluginGraphAnswerer({ owner, contract, manifest: repositoryManifest });
    const files = await graph.files('**/*.ts');
    expect(files).toEqual([file]);
    const found = files[0]!;
    const request = { kind: found.kind, key: found.key, keyEdges: found.keyEdges, field: 'language' };
    expect(Value.Check(PluginGraphValueRequest, request)).toBe(true);
    expect(await graph.value(request.kind, request.key, request.field, request.keyEdges)).toBe('typescript');
  } finally { await owner.close(); }
}, 30000);
