import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { SYSTEM_CONTRACT, withSystemContract } from '../src/graph/system-contract.js';
import { installSystemSources, registerSystemSource, installAgentSession } from '../src/graph/system-installation.js';

test('startup installs protected system kinds and retains the local person across starts', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: EMPTY_CONTRACT });
  try {
    const contract = withSystemContract(EMPTY_CONTRACT);
    const before = await installSystemSources(owner, contract);
    await prepareStore(owner);
    const after = await installSystemSources(owner, contract);
    expect(after.person.uid).toBe(before.person.uid);
    expect(after.system.uid).toBe(before.system.uid);
    const kinds = await owner.transaction('snapshot', async (tx) => await tx.query<{ name: string }>("SELECT name FROM entity WHERE sort = 'node'"));
    expect(kinds.rows.map((row) => row.name)).toEqual(expect.arrayContaining(SYSTEM_CONTRACT.vertex.map((kind) => kind.name)));
    expect(() => withSystemContract({ vertex: [{ ...SYSTEM_CONTRACT.vertex[0]!, key: ['label'] }], edge: [], dictionary: [] })).toThrow('protected system');
    const overlay = withSystemContract({ vertex: [{ ...SYSTEM_CONTRACT.vertex[0]!, fields: [...SYSTEM_CONTRACT.vertex[0]!.fields, { name: 'detail', type: 'text', nullable: true }] }], edge: [], dictionary: [] });
    expect(overlay.vertex.find((kind) => kind.name === 'run')?.fields.map((field) => field.name)).toEqual(['label', 'detail']);
    expect(before.person.uid[14]).toBe('7');
    const lineage = await owner.transaction('snapshot', tx => tx.query<{ kind: string }>("SELECT DISTINCT target_kind.name AS kind FROM edge e JOIN entity relation ON relation.id=e.entity_id JOIN node target ON target.id=e.to_node JOIN entity target_kind ON target_kind.id=target.entity_id WHERE relation.name IN ('system.assertion-source','system.assertion-author')"));
    expect(lineage.rows.length).toBeGreaterThan(0);
    expect(lineage.rows.every(row => ['source', 'person', 'plugin', 'agent', 'agent-session'].includes(row.kind))).toBe(true);
    expect(kinds.rows.some(row => ['system.source', 'system.person', 'system.plugin'].includes(row.name))).toBe(false);
  } finally { await owner.close(); }
}, 30000);

test('installed sources retain identity across versions while MCP sessions remain separate activities', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: EMPTY_CONTRACT });
  try {
    const contract = withSystemContract(EMPTY_CONTRACT);
    const first = await registerSystemSource(owner, contract, { type: 'plugin', installationKey: 'example', scope: 'output', version: '1' });
    const newer = await registerSystemSource(owner, contract, { type: 'plugin', installationKey: 'example', scope: 'output', version: '2' });
    const other = await registerSystemSource(owner, contract, { type: 'plugin', installationKey: 'example', scope: 'other', version: '2' });
    expect(newer.uid).toBe(first.uid);
    expect(other.uid).not.toBe(first.uid);
    expect(newer.version).toBe('2');
    const sessionA = await installAgentSession(owner, contract, 'first');
    const sessionB = await installAgentSession(owner, contract, 'second');
    expect(sessionA.uid).toBe(sessionB.uid);
    expect(sessionA.sessionUid).not.toBe(sessionB.sessionUid);
    const sessions = await owner.transaction('snapshot', async tx => await tx.query("SELECT n.uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='agent-session' AND graph_vertex_active(n.id,k.name,1)"));
    expect(sessions.rows).toHaveLength(2);
  } finally { await owner.close(); }
}, 30000);


test('an incompatible deployed reserved-kind contract refuses before changing retained facts', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: EMPTY_CONTRACT });
  try {
    const contract = withSystemContract(EMPTY_CONTRACT);
    const before = await installSystemSources(owner, contract);
    const held = await owner.transaction('snapshot', async (tx) => await tx.query<{ uid: string; key: unknown }>('SELECT uid::text AS uid, key FROM node ORDER BY uid'));
    const incompatible = { vertex: [{ name: 'event', table: 'k_legacy_event', capability: 'agent', fields: [{ name: 'name', type: 'text' as const }], key: ['name'] }], edge: [], dictionary: [] };
    await expect(prepareStore(owner, { contract: incompatible })).rejects.toThrow('protected system');
    await expect(prepareStore(owner, { contract: incompatible, reset: true })).rejects.toThrow('protected system');
    const after = await owner.transaction('snapshot', async (tx) => await tx.query<{ uid: string; key: unknown }>('SELECT uid::text AS uid, key FROM node ORDER BY uid'));
    expect(after.rows).toEqual(held.rows);
    expect((await installSystemSources(owner, contract)).person.uid).toBe(before.person.uid);
  } finally { await owner.close(); }
}, 30000);
