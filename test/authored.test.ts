import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { authoredEntity, shortestUid } from '../src/graph/authored.js';
import type { KindsManifest } from '../src/knowledge/kinds.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { createTestDatabaseOwner } from './test-database.js';

let owner: DatabaseOwner;
const manifest: KindsManifest = { ...parseKinds('kinds: {}', 'madarch/kinds.yaml', '/tmp'), kinds: new Map([
  ['note', { name: 'note', template: 'note.liquid', source: 'graph', origin: 'person', title: 'title', relations: [], line: 1, fields: [
    { name: 'title', type: 'text' }, { name: 'count', type: 'integer', nullable: true }, { name: 'flag', type: 'boolean', nullable: true },
  ] }],
  ['derived', { name: 'derived', template: 'derived.liquid', source: 'graph', origin: 'agent', title: 'title', relations: [], line: 2 }],
]) };
const call = (action: Parameters<typeof authoredEntity>[4], args: Parameters<typeof authoredEntity>[6] = {}) => owner.transaction('write', (tx) => authoredEntity(tx, manifest, 'fixture', 'Reader <reader@example.invalid>', action, 'note', args));
beforeAll(async () => { owner = await createTestDatabaseOwner(); await createOneGraphSchema(owner, graphContractOf(manifest)); });
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
