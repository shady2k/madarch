import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { prepareGraphSchema } from '../src/adapters/schemas/graph.js';
import { contextLayers, nextGraphRecordedSequence, pinContext } from '../src/graph/context.js';
import { reserveAssertionIdentity } from '../src/graph/operation-identity.js';

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

test('additive migration keeps legacy context identities and authored journal without a reset', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await owner.exec('DROP TRIGGER context_pin_guard ON context');
    await owner.exec('ALTER TABLE context DROP COLUMN parent_recorded_seq');
    await owner.exec(`INSERT INTO context (parent, ref) VALUES (1, 'legacy')`);
    await owner.exec(`INSERT INTO operation (author, words, change) VALUES ('person:fixture', 'keep', '{}'::jsonb)`);
    await owner.exec(`UPDATE madarch_meta.schema_stamp SET stamp = 'previous-shape' WHERE name = 'one-graph'`);
    expect(await prepareGraphSchema(owner)).toEqual({ reset: false });
    const legacy = await owner.run((tx) => tx.query<{ id: string }>("SELECT id::text AS id FROM context WHERE ref = 'legacy'"));
    expect(await owner.run((tx) => contextLayers(tx, legacy.rows[0]!.id))).toEqual([
      { id: legacy.rows[0]!.id, recordedThrough: null }, { id: '1', recordedThrough: '0' },
    ]);
    expect((await owner.run((tx) => tx.query("SELECT words FROM operation WHERE author = 'person:fixture'"))).rows).toEqual([{ words: 'keep' }]);
    expect(await prepareGraphSchema(owner)).toEqual({ reset: false });
  } finally { await owner.close(); }
});

test('operation slots retain distinct UUIDv7 receipts across transactions, concurrency and preparation', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    const operations = await owner.transaction('write', async (tx) => {
      await tx.query(`INSERT INTO entity (name, sort) VALUES ('operation', 'node'), ('fixture', 'node') ON CONFLICT (name) DO NOTHING`);
      return await tx.query<{ uid: string }>(`INSERT INTO node (entity_id) SELECT id FROM entity WHERE name IN ('operation', 'fixture') ORDER BY (name = 'operation') DESC RETURNING uid::text AS uid`);
    });
    const operation = operations.rows[0]!.uid;
    const first = await owner.transaction('write', (tx) => reserveAssertionIdentity(tx, operation, 'title', 'intent-v1'));
    await expect(owner.transaction('write', (tx) => reserveAssertionIdentity(tx, operation, 'title', 'different-intent'))).rejects.toThrow('different intent');
    await expect(owner.exec(`UPDATE operation_assertion_receipt SET slot = 'changed'`)).rejects.toThrow('immutable');
    await expect(owner.exec(`DELETE FROM operation_assertion_receipt`)).rejects.toThrow('immutable');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const parallel = await Promise.all([0, 1].map(() => owner.transaction('write', (tx) => reserveAssertionIdentity(tx, operation, 'parallel', 'intent-v1'))));
    expect(parallel[0]).toBe(parallel[1]);
    expect(parallel[0]).not.toBe(first);
    expect(await owner.transaction('write', (tx) => reserveAssertionIdentity(tx, operation, 'description', 'intent-v1'))).not.toBe(first);
    expect(await prepareGraphSchema(owner)).toEqual({ reset: false });
    expect(await owner.transaction('write', (tx) => reserveAssertionIdentity(tx, operation, 'title', 'intent-v1'))).toBe(first);
    await expect(owner.transaction('write', (tx) => reserveAssertionIdentity(tx, operations.rows[1]!.uid, 'title', 'intent-v1'))).rejects.toThrow('not a retained operation');
    await expect(owner.transaction('write', (tx) => reserveAssertionIdentity(tx, operation, '', 'intent-v1'))).rejects.toThrow('intent digest is empty');
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
