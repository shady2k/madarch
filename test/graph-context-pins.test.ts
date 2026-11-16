import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { contextLayers, nextGraphRecordedSequence, pinContext } from '../src/graph/context.js';

 test('pins retain database order across nested contexts, retries and later parent writes', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    let branch = '';
    let nested = '';
    let before = '';
    let after = '';
    await owner.transaction('write', async (tx) => {
      before = await nextGraphRecordedSequence(tx);
      branch = await pinContext(tx, '1', 'branch');
      after = await nextGraphRecordedSequence(tx);
      nested = await pinContext(tx, branch, 'nested');
    });
    const layers = await owner.run((tx) => contextLayers(tx, nested));
    expect(layers.map((layer) => layer.id)).toEqual([nested, branch, '1']);
    expect(layers[0]!.recordedThrough).toBeNull();
    expect(BigInt(layers[1]!.recordedThrough!)).toBeGreaterThan(BigInt(after));
    expect(BigInt(layers[2]!.recordedThrough!)).toBeGreaterThan(BigInt(before));
    expect(BigInt(layers[2]!.recordedThrough!)).toBeLessThan(BigInt(after));
    await owner.transaction('write', async (tx) => {
      await nextGraphRecordedSequence(tx);
      expect(await pinContext(tx, '1', 'branch')).toBe(branch);
    });
    expect(await owner.run((tx) => contextLayers(tx, nested))).toEqual(layers);
    await expect(owner.exec(`DELETE FROM context WHERE id = ${nested}`)).rejects.toThrow('immutable');
    await expect(owner.exec(`UPDATE context SET parent = ${nested} WHERE id = ${branch}`)).rejects.toThrow('immutable');
    await expect(owner.exec(`UPDATE context SET parent_recorded_seq = 999 WHERE id = ${branch}`)).rejects.toThrow('immutable');
    await expect(owner.exec(`UPDATE context SET ref = 'renamed' WHERE id = ${branch}`)).rejects.toThrow('immutable');
    await expect(owner.exec(`INSERT INTO context (parent, ref, parent_recorded_seq) VALUES (1, 'forged', 9)`)).rejects.toThrow('assigned by the database');
    await expect(owner.exec(`INSERT INTO context (ref, parent_recorded_seq) VALUES ('forged-root', 9)`)).rejects.toThrow('does not match');
    await expect(owner.run((tx) => contextLayers(tx, '99999'))).rejects.toThrow('does not exist');
  } finally { await owner.close(); }
});

test('parent publication and branch fences serialize until the accepting transaction commits', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    for (const first of ['publication', 'pin'] as const) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let announce!: () => void;
      const ready = new Promise<void>((resolve) => { announce = resolve; });
      let publicationSequence = '';
      let branch = '';
      let secondFinished = false;
      const accepting = owner.transaction('write', async (tx) => {
        if (first === 'publication') publicationSequence = await nextGraphRecordedSequence(tx);
        else branch = await pinContext(tx, '1', 'pin-first');
        announce();
        await held;
      });
      await ready;
      const following = owner.transaction('write', async (tx) => {
        if (first === 'publication') branch = await pinContext(tx, '1', 'publication-first');
        else publicationSequence = await nextGraphRecordedSequence(tx);
        secondFinished = true;
      });
      try {
        // A second connection must wait for commit, not merely obtain a larger sequence immediately.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondFinished).toBe(false);
      } finally { release(); }
      await Promise.all([accepting, following]);
      const layers = await owner.run((tx) => contextLayers(tx, branch));
      const fence = BigInt(layers[1]!.recordedThrough!);
      if (first === 'publication') expect(fence).toBeGreaterThan(BigInt(publicationSequence));
      else expect(fence).toBeLessThan(BigInt(publicationSequence));
    }
  } finally { await owner.close(); }
}, 20_000);

test('typed assertions use the same ordered sequence as pinned parent snapshots', async () => {
  const { bindWriteCapability, publishGraphDrafts } = await import('../src/graph/write.js');
  const { startupBinding } = await import('../src/graph/manifest-publication.js');
  const { prepareGraphSchema } = await import('../src/adapters/schemas/graph.js');
  const { generatedTableName } = await import('../src/graph/contract.js');
  const declared: import('../src/graph/contract.js').GraphContract = { vertex: [{ name: 'fixture', table: generatedTableName('fixture', 'vertex'),
    key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' }], edge: [], dictionary: [] };
  const owner = await createTestDatabaseOwner();
  try {
    await prepareGraphSchema(owner, declared);
    const write = async (remove = false) => await owner.transaction('write', async (tx) => {
      const { contract, binding } = await startupBinding(tx, declared, 'fixture-context');
      expect(binding.sourceUid).toBe(binding.principalUid);
      bindWriteCapability(tx, { ...binding, permissions: [{ kind: 'fixture', properties: ['*'], assert: true, retractOwn: true }] });
      await publishGraphDrafts(tx, contract, {
        vertices: remove ? [] : [{ kind: 'fixture', key: { name: 'pinned' }, producer: 'fixture', producerVersion: '1' }],
        removals: remove ? [{ kind: 'fixture', key: { name: 'pinned' }, producer: 'fixture' }] : [],
      });
    });
    await write();
    const branch = await owner.transaction('write', (tx) => pinContext(tx, '1', 'typed-branch'));
    await write(true);
    const result = await owner.run((tx) => tx.query<{ base: boolean; branch: boolean }>(
      `SELECT graph_vertex_active(n.id,'fixture',1) AS base,
        graph_vertex_active(n.id,'fixture',$1) AS branch FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture'`, [branch]));
    expect(result.rows).toEqual([{ base: false, branch: true }]);
    const fence = (await owner.run((tx) => contextLayers(tx, branch)))[1]!.recordedThrough!;
    const recorded = await owner.run((tx) => tx.query<{ seq: string }>('SELECT recorded_sequence::text AS seq FROM assertion ORDER BY recorded_sequence'));
    expect(recorded.rows.some((row) => BigInt(row.seq) < BigInt(fence))).toBe(true);
    expect(recorded.rows.some((row) => BigInt(row.seq) > BigInt(fence))).toBe(true);
  } finally { await owner.close(); }
});
