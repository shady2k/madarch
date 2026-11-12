import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { AuthoredRefusal, authoredEntity, shortestUid } from '../src/graph/authored.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { createTestDatabaseOwner } from './test-database.js';

let owner: DatabaseOwner;
const manifest: KindsManifest = { ...parseKinds('kinds: {}', 'madarch/catalog.yaml', '/tmp'), kinds: new Map([
  ['note', { name: 'note', template: 'note.liquid', source: 'graph', origin: 'person', title: 'title', relations: [], line: 1, fields: [
    { name: 'title', type: 'text' }, { name: 'count', type: 'integer', nullable: true }, { name: 'flag', type: 'boolean', nullable: true },
  ] }],
  ['derived', { name: 'derived', template: 'derived.liquid', source: 'graph', origin: 'agent', title: 'title', relations: [], line: 2 }],
  ['link', { name: 'link', template: 'link.liquid', source: 'graph', origin: 'person', title: 'target', relations: [], line: 3,
    fields: [{ name: 'target', type: 'json', reference: 'note' }],
  }],
]) };
const call = (action: Parameters<typeof authoredEntity>[4], args: Parameters<typeof authoredEntity>[6] = {}) => owner.transaction('write', (tx) => authoredEntity(tx, manifest, 'fixture', 'Reader <reader@example.invalid>', action, 'note', args));
beforeAll(async () => { owner = await createTestDatabaseOwner({ graphContract: graphContractOf(manifest) }); await createOneGraphSchema(owner, graphContractOf(manifest)); });
afterAll(async () => { await owner.close(); });

test('random authored identities preserve opinions, exact words and withdrawal history', async () => {
  const words = '  Original request\r\nwith original whitespace.  ';
  const made = (await call('create', { values: { title: 'A note', count: 3 }, words })).entity!;
  expect(made.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect((await call('read', { uid: made.id })).entity!.values).toEqual({ title: 'A note', count: 3, flag: null });
  const edited = (await call('edit', { uid: made.uid, values: { title: 'Changed', flag: true }, words: 'edit precisely' })).entity!;
  expect(edited.uid).toBe(made.uid);
  expect(made.id).toMatch(/^fixture-[0-9a-f]+$/u);
  expect(edited.values).toEqual({ title: 'Changed', count: 3, flag: true });
  await owner.transaction('write', (tx) => authoredEntity(tx, manifest, 'fixture', 'Other reader', 'delete', 'note', { uid: made.uid, words: 'withdraw precisely' }));
  expect((await call('list')).entities).toEqual([]);
  await expect(call('read', { uid: made.uid })).rejects.toThrow('entity not found');
  const operations = await owner.run((tx) => tx.query<{ author: string; words: string }>('SELECT author, words FROM operation ORDER BY seq'));
  expect(operations.rows).toEqual([
    { author: 'Reader <reader@example.invalid>', words },
    { author: 'Reader <reader@example.invalid>', words: 'edit precisely' },
    { author: 'Other reader', words: 'withdraw precisely' },
  ]);
  const history = await owner.run((tx) => tx.query<{ removed: boolean }>('SELECT removed FROM node WHERE uid = $1::uuid', [made.uid]));
  expect(history.rows[0]!.removed).toBe(true);
});

test('fields reject missing, undeclared and incorrectly typed values without publishing', async () => {
  for (const [values, message] of [[{}, 'title'], [{ title: 3 }, 'text'], [{ title: 'OK', count: 1.5 }, 'integer'], [{ title: 'OK', flag: 'yes' }, 'boolean'], [{ title: 'OK', extra: true }, 'extra']] as const) {
    await expect(call('create', { values })).rejects.toThrow(message);
  }
  await expect(owner.transaction('write', (tx) => authoredEntity(tx, manifest, '', 'Reader', 'create', 'derived', { values: {} }))).rejects.toThrow('does not let a person author');
  expect((await call('list')).entities).toEqual([]);
});

test('another person clears a nullable value while retaining the displayed fields', async () => {
  const made = (await call('create', { values: { title: 'Keep the title', count: 9 } })).entity!;
  const changed = await owner.transaction('write', (tx) => authoredEntity(tx, manifest, 'fixture', 'person:another-reader', 'edit', 'note', { uid: made.uid, values: { count: null }, words: 'Clear the count' }));
  expect(changed.entity!.values).toEqual({ title: 'Keep the title', count: null, flag: null });
  expect((await call('read', { uid: made.uid })).entity!.values).toEqual(changed.entity!.values);
  await call('delete', { uid: made.uid });
});

test('prefixes distinguish colliding and withdrawn graph identities', () => {
  expect(shortestUid('abc00000-0000-4000-8000-000000000000', ['abc00000-0000-4000-8000-000000000000', 'abd00000-0000-4000-8000-000000000000'])).toBe('abc');
});


test('withdrawn identities keep old prefixes ambiguous within their kind', async () => {
  const first = (await call('create', { values: { title: 'First collision' } })).entity!;
  const second = (await call('create', { values: { title: 'Second collision' } })).entity!;
  const uids = ['a0000000-0000-4000-8000-000000000000', 'ab000000-0000-4000-8000-000000000000'];
  await owner.transaction('write', async (tx) => {
    await tx.query('UPDATE node SET uid = $2::uuid WHERE uid = $1::uuid', [first.uid, uids[0]]);
    await tx.query('UPDATE node SET uid = $2::uuid WHERE uid = $1::uuid', [second.uid, uids[1]]);
  });
  await call('delete', { uid: uids[0] });
  await expect(call('read', { uid: 'fixture-a' })).rejects.toThrow(`ambiguous prefix: ${uids.map((uid) => `fixture-${uid.replaceAll('-', '')}`).join(', ')}`);
  await expect(call('read', { uid: uids[0] })).rejects.toThrow('entity was deleted');
  expect((await call('read', { uid: uids[1] })).entity!.id).toBe('fixture-ab');
  await call('delete', { uid: uids[1] });
});

test('reference fields require the declared kind and an object key on create and edit', async () => {
  const link = (action: Parameters<typeof authoredEntity>[4], args: Parameters<typeof authoredEntity>[6]) => owner.transaction('write', (tx) => authoredEntity(tx, manifest, 'fixture', 'Reader', action, 'link', args));
  const made = (await link('create', { values: { target: { kind: 'note', key: {} } } })).entity!;
  for (const target of [{ kind: 'wrong', key: {} }, { kind: 'note', key: null }, { kind: 'note', key: [] }, { kind: 'note', key: 'bad' }]) {
    await expect(link('create', { values: { target } })).rejects.toThrow('field "target": expected a reference to note');
    await expect(link('edit', { uid: made.uid, values: { target } })).rejects.toThrow('field "target": expected a reference to note');
  }
});

test('revision rejects changed fields but merges unchanged fields against complete closed history', async () => {
  const made = (await call('create', { values: { title: 'Baseline', count: 1 } })).entity!;
  expect(made.revision).toMatch(/^[0-9]+$/u);
  const changed = (await call('edit', { uid: made.uid, values: { title: 'Changed by first reader' }, ifRevision: made.revision })).entity!;
  expect(BigInt(changed.revision)).toBeGreaterThan(BigInt(made.revision));
  const merged = (await owner.transaction('write', (tx) => authoredEntity(tx, manifest, 'fixture', 'Second reader', 'edit', 'note', {
    uid: made.uid, values: { count: 2 }, ifRevision: made.revision,
  }))).entity!;
  expect(merged.values).toEqual({ title: 'Changed by first reader', count: 2, flag: null });
  try {
    await call('edit', { uid: made.uid, values: { title: 'Stale overwrite' }, ifRevision: made.revision });
    throw new Error('expected a conflict');
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoredRefusal);
    const refusal = error as AuthoredRefusal;
    expect(refusal.status).toBe(412);
    expect(refusal.conflict).toEqual({ field: 'title', current: 'Changed by first reader', author: 'Reader <reader@example.invalid>' });
  }
  await call('edit', { uid: made.uid, values: { title: 'Baseline' }, ifRevision: merged.revision });
  await expect(call('edit', { uid: made.uid, values: { title: 'Stale after restoration' }, ifRevision: made.revision })).rejects.toThrow('changed since revision');
  const restored = (await call('read', { uid: made.uid })).entity!;
  const same = (await call('edit', { uid: made.uid, values: { count: 2 }, ifRevision: restored.revision })).entity!;
  expect((await call('read', { uid: made.uid })).entity!.revision).toBe(same.revision);
  expect((await call('list')).entities!.find((entity) => entity.uid === made.uid)!.revision).toBe(same.revision);
  for (const ifRevision of ['0', 'no revision', '999999999999999999999999', changed.revision + '0']) {
    await expect(call('edit', { uid: made.uid, values: { count: 3 }, ifRevision })).rejects.toThrow('revision');
  }
  const unrelated = (await call('create', { values: { title: 'Another entity' } })).entity!;
  await expect(call('edit', { uid: made.uid, values: { count: 3 }, ifRevision: unrelated.revision })).rejects.toThrow('revision');
  await call('delete', { uid: made.uid });
  await call('delete', { uid: unrelated.uid });
});

test('conditional deletes reject every intervening change and invalid revisions without writing', async () => {
  const made = (await call('create', { values: { title: 'Delete baseline', count: 1 } })).entity!;
  const unrelated = (await call('create', { values: { title: 'Different revision owner' } })).entity!;
  await call('edit', { uid: made.uid, values: { count: 2 } });
  const current = (await call('edit', { uid: made.uid, values: { count: 1 } })).entity!;
  const before = await owner.run((tx) => tx.query('SELECT * FROM operation ORDER BY seq'));
  for (const ifRevision of [made.revision, '0', 'malformed', '999999999999999999999999', unrelated.revision]) {
    try {
      await call('delete', { uid: made.uid, ifRevision, words: 'Must not be recorded' });
      throw new Error('expected conditional deletion refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoredRefusal);
      expect((error as AuthoredRefusal).status).toBe(412);
    }
    expect((await call('read', { uid: made.uid })).entity).toEqual(current);
    expect((await owner.run((tx) => tx.query('SELECT * FROM operation ORDER BY seq'))).rows).toEqual(before.rows);
  }
  expect((await call('delete', { uid: made.uid, ifRevision: current.revision })).entity!.uid).toBe(made.uid);
  await expect(call('read', { uid: made.uid })).rejects.toThrow('entity was deleted');
  await call('delete', { uid: unrelated.uid });
});
