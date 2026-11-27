import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf } from '../src/plugin/closure.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts, bindWriteCapability } from '../src/graph/write.js';
import { initializeOperationScope } from '../src/graph/operation-host.js';
import { newUid } from '../src/graph/uid.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const OTHER_SOURCE_UID = '019a0000-0000-7000-8000-000000000003';

const contract: GraphContract = {
  vertex: [
    { name: 'hub', table: generatedTableName('hub', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'retract-probe' },
    { name: 'item', table: generatedTableName('item', 'vertex'), key: ['name'],
      keyEdges: [{ role: 'hub', edge: 'item-hub', direction: 'from', onDelete: 'restrict' }],
      fields: [{ name: 'name', type: 'text' }, { name: 'text', type: 'text' }], capability: 'retract-probe' },
  ],
  edge: [{ name: 'item-hub', table: generatedTableName('item-hub', 'edge'), from: ['item'], to: ['hub'], repeats: false,
    cardinality: { from: 'many', to: 'one' }, labels: { en: { out: 'in hub', in: 'holds' }, ru: { out: 'в хабе', in: 'держит' } },
    fields: [], capability: 'retract-probe' }],
  dictionary: [],
};
const field = (name: string, required: boolean) => ({ name, type: 'text' as const, meaning: `the ${name}`, example: name, required });
const outputs = {
  vertices: [
    { kind: 'hub', key: ['name'], fields: [field('name', true)] },
    { kind: 'item', key: ['name'], keyEdges: [{ role: 'hub', edge: 'item-hub', direction: 'from' as const, onDelete: 'restrict' as const }],
      fields: [field('name', true), field('text', false)] },
  ],
  edges: [{ kind: 'item-hub', from: 'item', to: 'hub', cardinality: { from: 'many' as const, to: 'one' as const },
    labels: { en: { out: 'in hub', in: 'holds' }, ru: { out: 'в хабе', in: 'держит' } }, fields: [] }],
};
const itemRef = (name: string) => ({ kind: 'item', key: { name }, keyEdges: { hub: { kind: 'hub', key: { name: 'main' } } } });
const producer = { producer: 'retract-probe', producerVersion: '1' };

async function publishItems(owner: DatabaseOwner, sourceUid: string, items: readonly { name: string; text: string }[], hub = false): Promise<void> {
  await owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, contract, sourceUid);
    await publishGraphDrafts(tx, contract, {
      vertices: [
        ...(hub ? [{ kind: 'hub', key: { name: 'main' }, ...producer }] : []),
        ...items.map(entry => ({ ...itemRef(entry.name), values: { text: entry.text }, ...producer })),
      ],
      removals: [],
    });
  });
}

async function withTurn(produced: unknown, seed: (owner: DatabaseOwner) => Promise<void>, verify: (owner: DatabaseOwner) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'madarch-retraction-'));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const declaration = { name: 'retract-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'hub', fields: '*' }, { kind: 'item', fields: '*' }] };
    writeFileSync(join(root, 'plugin.json'), JSON.stringify(declaration));
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: declaration.name, version: declaration.version, outputs, rights: { network: 'none', graph: true, graphReads: ['ownFacts'] } }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'retract-probe', version: '1.0.0', graph: true, graphReads: ['ownFacts'], contract: ${JSON.stringify(outputs)},
  async extract() { return ${JSON.stringify(produced)}; } });`);
    const closure = closureOf(root);
    const runUid = newUid(), unitUid = newUid();
    await owner.transaction('write', async tx => {
      const binding = await bindTestWriteCapability(tx, contract, TEST_SOURCE_UID);
      await initializeOperationScope(tx, contract, binding, runUid, unitUid);
    });
    const plugin = { id: declaration.name, version: declaration.version, path: '.', inputs: [], outputs: ['hub', 'item'], closure: [], declaration, contract: outputs, line: 1 };
    const kind = (name: string, line: number, extra: Record<string, unknown>) => ({ name, source: 'graph', fields: [{ name: 'name', type: 'text' }, ...(name === 'item' ? [{ name: 'text', type: 'text' }] : [])], relations: [], title: 'name', line, ...extra });
    const wiring = {
      sourceUid: TEST_SOURCE_UID,
      executeOperation: async <Result>(_unit: string, _key: string, _request: unknown, apply: (tx: import('../src/history-types.js').OuterTransaction) => Promise<Result>) => await owner.transaction('write', async tx => {
        const binding = await bindTestWriteCapability(tx, contract, TEST_SOURCE_UID);
        bindWriteCapability(tx, { ...binding, unitUid });
        return await apply(tx);
      }),
      productFolder: root,
      manifest: { file: join(root, 'kinds.yaml'), kinds: new Map([
        ['hub', kind('hub', 1, {})],
        ['item', kind('item', 2, { keyEdges: [{ role: 'hub', edge: 'item-hub', direction: 'from', onDelete: 'restrict' }] })],
      ]), plugins: new Map([[plugin.id, plugin]]) },
      locks: new Map([[plugin.id, { id: plugin.id, version: '1.0.0', closure: closure.hash }]]),
      owner,
      snapshots: { pins: async () => [] },
      contract,
      releaseHashes: [closure.hash],
      unconfined: true,
    } as unknown as PluginTurnWiring;
    await seed(owner);
    await runPluginTurn(wiring, 'retract-probe:item', () => undefined);
    await verify(owner);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function nodeOf(owner: DatabaseOwner, name: string): Promise<{ id: string; uid: string; active: boolean }> {
  return await owner.transaction('snapshot', async tx => {
    const rows = (await tx.query<{ id: string; uid: string; active: boolean }>(
      `SELECT n.id::text AS id,n.uid::text AS uid,graph_vertex_active(n.id,'item',1) AS active
       FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='item' AND n.key->>'name'=$1`, [name])).rows;
    if (rows.length !== 1) throw new Error(`expected one item ${name}, found ${rows.length}`);
    return rows[0]!;
  });
}

async function keyEdgeActive(owner: DatabaseOwner, itemId: string): Promise<boolean[]> {
  return await owner.transaction('snapshot', async tx => (await tx.query<{ active: boolean }>(
    `SELECT graph_edge_active(e.id,'item-hub',1) AS active FROM edge e JOIN entity k ON k.id=e.entity_id
     WHERE k.name='item-hub' AND e.from_node=$1::bigint`, [itemId])).rows.map(row => row.active));
}

async function existence(owner: DatabaseOwner, itemId: number, sourceUid: string): Promise<number> {
  const rows = await owner.transaction('snapshot', tx => loadAssertions(tx, 'vertex', 'item', ['$exists'], [itemId], { sourceUids: [sourceUid] }));
  return rows.filter(row => row.active === true && row.operation === 'assert' && row.value === true).length;
}

test('a plugin retraction does not hide an entity another source states exists', async () => {
  await withTurn({ vertices: [], edges: [], end: { state: 'complete' } },
    async owner => {
      await publishItems(owner, TEST_SOURCE_UID, [{ name: 'keep', text: 'one' }], true);
      await publishItems(owner, OTHER_SOURCE_UID, [{ name: 'keep', text: 'one' }]);
    },
    async owner => {
      const held = await nodeOf(owner, 'keep');
      expect(held.active).toBe(true);
      expect(await existence(owner, Number(held.id), TEST_SOURCE_UID)).toBe(0);
      expect(await existence(owner, Number(held.id), OTHER_SOURCE_UID)).toBe(1);
    });
}, 60_000);

test('a retracted entity keeps its uid when it reappears', async () => {
  await withTurn({ vertices: [], edges: [], end: { state: 'complete' } },
    async owner => { await publishItems(owner, TEST_SOURCE_UID, [{ name: 'keep', text: 'one' }], true); },
    async owner => {
      const gone = await nodeOf(owner, 'keep');
      expect(gone.active).toBe(false);
      await publishItems(owner, TEST_SOURCE_UID, [{ name: 'keep', text: 'one' }]);
      const again = await nodeOf(owner, 'keep');
      expect(again.active).toBe(true);
      expect(again.uid).toBe(gone.uid);
    });
}, 60_000);

test('a child that stays in the answer keeps its key edge through reconciliation', async () => {
  await withTurn({ vertices: [{ ...itemRef('keep'), values: { text: 'one' } }], edges: [], end: { state: 'complete' } },
    async owner => { await publishItems(owner, TEST_SOURCE_UID, [{ name: 'keep', text: 'one' }], true); },
    async owner => {
      const kept = await nodeOf(owner, 'keep');
      expect(kept.active).toBe(true);
      expect(await keyEdgeActive(owner, kept.id)).toEqual([true]);
    });
}, 60_000);

test('a child that leaves the answer goes with its key edge, without CARDINALITY_INVALID', async () => {
  await withTurn({ vertices: [], edges: [], end: { state: 'complete' } },
    async owner => { await publishItems(owner, TEST_SOURCE_UID, [{ name: 'drop', text: 'one' }], true); },
    async owner => {
      const gone = await nodeOf(owner, 'drop');
      expect(gone.active).toBe(false);
      expect((await keyEdgeActive(owner, gone.id)).some(active => active)).toBe(false);
    });
}, 60_000);
