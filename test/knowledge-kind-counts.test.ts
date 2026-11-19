import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { generatedTableName, type GraphContract, type VertexDraft } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { GraphReader, type GeneratedKindRead } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

const contract: GraphContract = {
  vertex: ['code.repository', 'example.topic', 'example.repository'].map(name => ({
    name, table: generatedTableName(name, 'vertex'), key: ['name'],
    fields: [{ name: 'name', type: 'text' }], capability: 'fixture',
  })),
  edge: [], dictionary: [],
};
const generated = new Map<string, GeneratedKindRead>(contract.vertex.map(kind => [kind.name, {
  kind: kind.name, table: kind.table, key: kind.key, columns: [], types: { name: 'text' },
}]));

async function publish(owner: DatabaseOwner, entities: readonly { kind: string; name: string }[]): Promise<void> {
  const vertices: VertexDraft[] = entities.map(({ kind, name }) => ({
    kind, key: { name }, producer: 'fixture', producerVersion: '1',
  }));
  await owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices, removals: [] }));
}

function observedOwner(owner: DatabaseOwner, snapshot: () => void): DatabaseOwner {
  return { ...owner, transaction: async (mode, work) => {
    if (mode === 'snapshot') snapshot();
    return await owner.transaction(mode, work);
  } };
}

const validAt = () => new Date().toISOString();

test.each([0, 1])('wiki counts use canonical declared repository identities (%i additional)', async (additional) => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await publish(owner, [
      { kind: 'code.repository', name: 'fixture' },
      ...Array.from({ length: additional }, (_, index) => ({ kind: 'code.repository', name: `extra-${index}` })),
      ...['one', 'two', 'three'].map(name => ({ kind: 'example.topic', name })),
      { kind: 'example.repository', name: 'fixture' },
    ]);
    // Re-observing an identity must not inflate its kind's total.
    await publish(owner, [{ kind: 'code.repository', name: 'fixture' }]);
    let snapshots = 0;
    const kinds = new Map([...generated].filter(([kind]) => kind !== 'example.repository').reverse());
    const reader = new GraphReader(observedOwner(owner, () => snapshots++), validAt, undefined, undefined,
      new Set(kinds.keys()), kinds, undefined, contract);
    expect(await reader.kindCounts()).toEqual([
      { kind: 'code.repository', count: 1 + additional },
      { kind: 'example.topic', count: 3 },
    ]);
    expect(snapshots).toBe(1);
  } finally {
    await owner.close();
  }
});

test('find of an empty declared repository source does not query another source', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await publish(owner, [{ kind: 'example.repository', name: 'fixture' }]);
    const reader = new GraphReader(owner, validAt, undefined, undefined, new Set(['code.repository']),
      new Map([['code.repository', generated.get('code.repository')!]]), undefined, contract);
    expect(await reader.find('code.repository:fixture')).toEqual([]);
    expect(await reader.kindCounts()).toEqual([{ kind: 'code.repository', count: 0 }]);
    const other = new GraphReader(owner, validAt, undefined, undefined, new Set(['example.repository']),
      new Map([['example.repository', generated.get('example.repository')!]]), undefined, contract);
    expect((await other.find('example.repository:fixture')).map(entity => entity.key)).toEqual(['example.repository:fixture']);
  } finally {
    await owner.close();
  }
});

test.each([false, true])('find reads only the mapped canonical kind (%s declared)', async (declared) => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await publish(owner, [
      { kind: 'code.repository', name: 'fixture' },
      { kind: 'example.repository', name: 'fixture' },
    ]);
    let snapshots = 0;
    const reader = new GraphReader(observedOwner(owner, () => snapshots++), validAt, undefined, undefined,
      new Set(declared ? ['code.repository'] : []),
      new Map(declared ? [['code.repository', generated.get('code.repository')!]] : []), undefined, contract);
    const matches = await reader.find('code.repository:fixture');
    expect(matches.map(entity => entity.key)).toEqual(declared ? ['code.repository:fixture'] : []);
    expect(matches.map(entity => entity.kind)).toEqual(declared ? ['code.repository'] : []);
    expect(snapshots).toBe(declared ? 1 : 0);
  } finally {
    await owner.close();
  }
});

test.each([undefined, new Map<string, GeneratedKindRead>()])('find and counts of undeclared kinds open no snapshot (%s mappings)', async (kinds) => {
  const owner = { transaction: () => { throw new Error('undeclared kinds must not open a snapshot'); } } as unknown as DatabaseOwner;
  const reader = new GraphReader(owner, validAt, undefined, undefined, new Set(), kinds);
  expect(await reader.find('example.unknown:fixture')).toEqual([]);
  expect(await reader.kindCounts()).toEqual([]);
});
