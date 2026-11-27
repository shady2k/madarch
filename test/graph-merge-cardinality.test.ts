import { expect, test } from 'bun:test';
import { resolveDuplicate, unmerge } from '../src/graph/merges.js';
import { readKindAssertions } from '../src/graph/records.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { contract, fixture, productContract } from './dispute-merge-fixture.js';

const producer = { producer: 'fixture', producerVersion: '1' };

test('replacing an alias edge still counts the required relation on the survivor', async () => {
  const f = await fixture();
  try {
    const merge = await f.execute(f.r, tx => resolveDuplicate(tx, contract, f.r, f.input));
    expect(merge.kind).toBe('system.merge');

    const alias = { kind: 'sample', key: { name: 'two' } };
    const parent = { kind: 'other', key: { name: 'parent' } };
    const extra = { kind: 'other', key: { name: 'extra' } };
    // The alias retains one link, while the merged vertex links to both parent and extra.
    await expect(f.execute(f.a, tx => publishGraphDrafts(tx, contract, {
      vertices: [{ ...extra, values: { synonyms: [] }, ...producer }],
      edges: [{ kind: 'related', from: alias, to: extra, ...producer }],
      edgeRemovals: [{ kind: 'related', from: alias, to: parent, producer: producer.producer }],
      removals: [],
    }))).rejects.toThrow('CARDINALITY_INVALID for related');
  } finally {
    await f.owner.close();
  }
});

test('unmerging with an edge allocation checks the incoming bound at the far endpoint', async () => {
  const kind = 'child-parent';
  const declared = withAssertionContract({
    ...productContract,
    edge: [...productContract.edge, {
      name: kind,
      from: ['sample'],
      to: ['other'],
      repeats: false,
      cardinality: { from: 'optional', to: 'many' },
      labels: { en: { out: 'parent', in: 'children' }, ru: { out: 'parent', in: 'children' } },
      fields: [],
      capability: 'fixture',
    }],
  });
  const f = await fixture(declared);
  try {
    const [survivor, alias] = [...f.rows].sort((a, b) => a.id - b.id);
    const parent = { kind: 'other', key: { name: 'bounded-parent' } };
    await f.execute(f.a, tx => publishGraphDrafts(tx, declared, {
      vertices: [{ ...parent, values: { synonyms: [] }, ...producer }],
      edges: [{ kind, from: { kind: 'sample', key: alias!.key }, to: parent, ...producer }],
      removals: [],
    }));
    const [standing] = await f.owner.transaction('snapshot', tx =>
      readKindAssertions(tx, 'edge', kind, [], { contract: declared }));
    const merge = await f.execute(f.r, tx => resolveDuplicate(tx, declared, f.r, f.input));
    expect(merge.kind).toBe('system.merge');

    // Later assertions on the survivor need an explicit allocation at unmerge.
    await f.execute(f.a, tx => publishGraphDrafts(tx, declared, {
      vertices: [],
      edges: [{ kind, from: { kind: 'sample', key: survivor!.key }, to: parent, ...producer }],
      removals: [],
    }));
    const projected = await f.owner.transaction('snapshot', tx =>
      readKindAssertions(tx, 'edge', kind, [], { contract: declared }));
    expect(projected.map(({ from, to }) => [from, to])).toEqual([
      [survivor!.id, standing!.to],
      [survivor!.id, standing!.to],
    ]);
    const later = projected.find(edge => edge.id !== standing!.id)!;
    const assertion = later.selectedAssertions.find(assertion => assertion.property === '$exists')!;

    // The split leaves one link per member, both pointing into the same bounded parent.
    await expect(f.execute(f.r, tx => unmerge(tx, declared, f.r, {
      mergeUid: merge.uid,
      reason: 'Allocate the later edge to its authoring member',
      evidence: f.input.evidence,
      allocations: [{ assertionUid: assertion.id, memberUid: survivor!.uid, direction: 'from' }],
    }))).rejects.toThrow(`CARDINALITY_INVALID for ${kind}`);
  } finally {
    await f.owner.close();
  }
});
