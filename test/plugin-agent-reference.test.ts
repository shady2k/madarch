import { expect, test } from 'bun:test';
import type { AcpConnection, AcpSession } from '../src/fill/acp.js';
import { PluginAgentBridge } from '../src/plugin/agent.js';
import { canonicalKey, validateUnitResult } from '../src/plugin/results.js';
import type { PluginKeyValues } from '../src/plugin/protocol.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { createTestDatabaseOwner } from './test-database.js';

test('agent natural-key references survive validation and real graph publication', async () => {
  const contract: GraphContract = { vertex: [
    { name: 'repository', table: generatedTableName('repository', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' },
    { name: 'summary', table: generatedTableName('summary', 'vertex'), key: ['repository', 'name'], fields: [{ name: 'repository', type: 'text', reference: 'repository' }, { name: 'name', type: 'text' }], capability: 'fixture' },
  ], edge: [], dictionary: [] };
  const outputs = { vertices: [{ kind: 'summary', key: ['repository', 'name'], fields: [{ name: 'repository', type: 'text' as const, reference: 'repository', required: true, meaning: 'Repository', example: 'repo' }] }], edges: [] };
  const answer = { vertices: [{ kind: 'summary', key: { repository: { kind: 'repository', key: { name: 'repo' } }, name: 'A' }, evidence: { repository: 'repo', path: 'a.md', lineStart: 1, lineEnd: 1 } }], end: { state: 'complete' } };
  const bridge = new PluginAgentBridge({ prompt: 'Extract', roots: ['repo'] }, {
    adapter: { id: 'fixture', command: 'unused' },
    connect: async () => ({ initialize: async () => ({}), close: async () => {}, newSession: async () => ({ sessionId: 'fixture', model: null, models: null, configOptions: [], usage: () => ({ reported: false, turns: 1, reports: 0 }), prompt: async () => ({ text: JSON.stringify(answer), stopReason: 'end_turn', updates: [] }) } as unknown as AcpSession) } as unknown as AcpConnection),
  }, { files: async () => [{ kind: 'file', key: { repository: 'repo', path: 'a.md' } }], value: async () => 'Source' }, outputs);
  const owner = await createTestDatabaseOwner();
  try {
    await createOneGraphSchema(owner, contract);
    const result = await bridge.run('unit', {});
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, { vertices: [
      { kind: 'repository', key: { name: 'repo' }, producer: 'fixture', producerVersion: '1' },
      ...result.vertices!.map((vertex) => ({ ...vertex, producer: 'fixture', producerVersion: '1', evidence: [] })),
    ], removals: [] }));
    const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ key: unknown }>("SELECT key FROM node WHERE entity_id = (SELECT id FROM entity WHERE name = 'summary')"));
    expect(rows.rows).toEqual([{ key: { repository: { kind: 'repository', key: { name: 'repo' } }, name: 'A' } }]);
    const unresolved = await owner.transaction('snapshot', async (tx) => await tx.query('SELECT * FROM unresolved_reference'));
    expect(unresolved.rows).toHaveLength(0);
  } finally { await bridge.close(); await owner.close(); }
}, 20_000);

test('reference keys validate targets and sort recursively, including edge ends and removals', () => {
  const contract = { vertices: [
    { kind: 'repository', key: ['name', 'region'] },
    { kind: 'summary', key: ['repository', 'name'], fields: [{ name: 'repository', type: 'text' as const, reference: 'repository', required: true, meaning: 'Repository', example: 'repo' }] },
  ], edges: [{ kind: 'link', from: 'summary', to: 'summary' }] };
  const good = { repository: { kind: 'repository', key: { name: 'repo', region: 'one' } }, name: 'A' };
  const reordered = { name: 'A', repository: { kind: 'repository', key: { region: 'one', name: 'repo' } } };
  expect(canonicalKey(good)).toBe(canonicalKey(reordered));
  const invalid: PluginKeyValues[string][] = ['repo', { kind: 'wrong', key: { name: 'repo', region: 'one' } }, { kind: 'repository', key: { name: 'repo' } }];
  for (const repository of invalid) {
    const key = { ...good, repository };
    for (const body of [{ vertices: [{ kind: 'summary', key }] }, { edges: [{ kind: 'link', from: { kind: 'summary', key }, to: { kind: 'summary', key: good } }] }, { removals: [{ kind: 'summary', key }] }]) {
      expect(validateUnitResult(contract, { unitId: 'unit', ...body, end: { state: 'complete' } }).ok).toBe(false);
    }
  }
  const duplicate = validateUnitResult(contract, { unitId: 'unit', vertices: [{ kind: 'summary', key: good }, { kind: 'summary', key: reordered }], end: { state: 'complete' } });
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.refusal.code).toBe('duplicate-vertex');
});
