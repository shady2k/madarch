import { testHostBinding } from './host-binding-fixture.js';
import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { activateGraphProducer } from '../src/graph/producer-binding.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { installDisputeSelection, readDispute, reconcileDisputes, refreshDisputeSelection, resolveDispute } from '../src/graph/disputes.js';
import { sha256Hex } from '../src/graph/digest.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

const table = generatedTableName('fixture.page', 'vertex');
const contract: GraphContract = {
  vertex: [{ name: 'fixture.page', table, capability: 'fixture', key: ['slug'], fields: [{ name: 'slug', type: 'text' }, { name: 'body', type: 'text' }] }],
  edge: [], dictionary: [],
};
const generated = new Map([['fixture.page', { kind: 'fixture.page', table, key: ['slug'], columns: ['body'], types: { body: 'text' as const } }]]);

test('generated pages count before the cursor, preserve empty totals, and read page membership in one statement', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const binding = await testHostBinding(owner, contract, 'fixture');
    await owner.transaction('write', (tx) => publishGraphDrafts(tx, contract, {
      vertices: ['Alpha', 'Beta', 'Zulu', 'removed'].map((slug) => ({ kind: 'fixture.page', key: { slug }, values: { body: `body ${slug}` }, producer: 'fixture', producerVersion: '1' })),
      removals: [],
    }, 1, { binding }));
    await owner.transaction('write', async (tx) => {
      await activateGraphProducer(tx, contract, binding);
      const removed = await tx.query<{ id: string }>(
        "SELECT n.id::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 AND n.key->>'slug'=$2", ['fixture.page', 'removed']);
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'fixture.page', subjectId: removed.rows[0]!.id, property: '$exists', operation: 'assert', value: false });
    });
    await owner.transaction('snapshot', async (tx) => {
      const statements: string[] = [];
      const measured = { query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        statements.push(sql);
        return await tx.query<Row>(sql, values);
      } };
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, measured, undefined, generated, undefined, owner.graphContract);
      const first = await reader.list('fixture.page', { limit: 1 });
      expect(first.rows.map((entity) => entity.key)).toEqual(['fixture.page:Alpha']);
      expect(first.rows[0]?.properties['body']).toBe('body Alpha');
      expect(first.next).toBe('fixture.page:Alpha');
      expect(first.total).toBe(3);
      // Membership and total share a statement; only the selected page's opinions are read separately.
      expect(statements.length).toBe(2);
      statements.length = 0;
      const rest = await reader.list('fixture.page', { limit: 5, after: first.next! });
      expect(rest.rows.map((entity) => entity.key)).toEqual(['fixture.page:Beta', 'fixture.page:Zulu']);
      expect(rest.total).toBe(3);
      expect(rest.next).toBeNull();
      const searched = await reader.list('fixture.page', { limit: 1, q: '  ALp  ' });
      expect(searched.rows.map((entity) => entity.key)).toEqual(['fixture.page:Alpha']);
      expect(searched.total).toBe(1);
      expect(searched.next).toBeNull();
      statements.length = 0;
      const exhausted = await reader.list('fixture.page', { limit: 1, after: 'fixture.page:Zulu' });
      expect(exhausted).toEqual({ rows: [], next: null, total: 3 });
      expect(statements.length).toBe(1);
      statements.length = 0;
      expect(await reader.list('fixture.page', { limit: 1, q: 'no match' })).toEqual({ rows: [], next: null, total: 0 });
      expect(statements.length).toBe(1);
    });
  } finally { await owner.close(); }
});

const labelledContract = withAssertionContract({
  ...contract,
  vertex: contract.vertex.map(kind => ({ ...kind, fields: [...kind.fields, { name: 'label', type: 'text' as const }] })),
});
const labelledGenerated = new Map([['fixture.page', {
  kind: 'fixture.page', table, key: ['slug'], columns: ['body', 'label'],
  types: { body: 'text' as const, label: 'text' as const },
}]]);

test('generated pages use persisted evidence-valid label and existence resolutions for membership and search', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: labelledContract });
  try {
    const first = await testHostBinding(owner, labelledContract, 'page-first');
    const second = await testHostBinding(owner, labelledContract, 'page-second');
    const resolver = await testHostBinding(owner, labelledContract, 'page-resolver');
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, labelledContract, first);
      await installDisputeSelection(tx, labelledContract);
      await publishGraphDrafts(tx, labelledContract, {
        vertices: ['kept', 'retired'].map(slug => ({
          kind: 'fixture.page', key: { slug }, values: { body: `body ${slug}`, label: slug === 'kept' ? 'Chosen title' : 'Retired title' },
          validFrom: '2020-01-01T00:00:00Z', producer: 'fixture', producerVersion: '1',
        })), removals: [],
      });
      const retired = (await tx.query<{ id: string }>("SELECT n.id::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.page' AND n.key->>'slug'='retired'")).rows[0]!;
      await writeAssertion(tx, labelledContract, { sort: 'vertex', kind: 'fixture.page', subjectId: retired.id, property: '$exists', operation: 'assert', value: false, validFrom: '2020-01-01T00:00:00Z' });
      await reconcileDisputes(tx, labelledContract);
      await refreshDisputeSelection(tx, labelledContract);
    });
    const subjects = (await owner.run(tx => tx.query<{ id: string; slug: string }>(
      "SELECT n.id::text AS id,n.key->>'slug' AS slug FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.page'",
    ))).rows;
    const kept = subjects.find(row => row.slug === 'kept')!;
    const retired = subjects.find(row => row.slug === 'retired')!;
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, labelledContract, second);
      await installDisputeSelection(tx, labelledContract);
      await writeAssertion(tx, labelledContract, { sort: 'vertex', kind: 'fixture.page', subjectId: kept.id, property: 'label', operation: 'assert', value: 'Rejected title', validFrom: '2020-01-01T00:00:00Z' });
      await writeAssertion(tx, labelledContract, { sort: 'vertex', kind: 'fixture.page', subjectId: retired.id, property: '$exists', operation: 'assert', value: true, validFrom: '2020-01-01T00:00:00Z' });
      await reconcileDisputes(tx, labelledContract);
      await refreshDisputeSelection(tx, labelledContract);
    });
    const content = 'Verified page title and retirement evidence';
    const digest = sha256Hex(Buffer.from(content));
    const resolutions: string[] = [];
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, labelledContract, resolver);
      await installDisputeSelection(tx, labelledContract);
      await publishGraphDrafts(tx, labelledContract, {
        vertices: [{ kind: 'system.content-snapshot', key: { digest }, values: { content }, producer: 'fixture', producerVersion: '1' }], removals: [],
      });
      for (const slot of [{ subject: kept, property: 'label', value: 'Chosen title' }, { subject: retired, property: '$exists', value: false }]) {
        const rows = await loadAssertions(tx, 'vertex', 'fixture.page', [slot.property], [Number(slot.subject.id)]);
        const at = new Date().toISOString();
        const question = await readDispute(tx, labelledContract, rows, { validAt: at, recordedAt: at, contexts: [1] });
        expect(question?.state).toBe('OPEN');
        const chosen = rows.find(row => row.source === first.sourceUid && row.value === slot.value)!;
        const newer = rows.find(row => row.source === second.sourceUid)!;
        expect(BigInt(chosen.recordedSequence) < BigInt(newer.recordedSequence)).toBe(true);
        resolutions.push(await resolveDispute(tx, labelledContract, resolver, {
          questionUid: question!.id, chosenAssertionUid: chosen.id, expectedCandidates: question!.candidates,
          rationale: 'Verified against the immutable content snapshot', evidence: [{ target: { kind: 'system.content-snapshot', key: { digest } } }],
        }));
      }
      await reconcileDisputes(tx, labelledContract);
      await refreshDisputeSelection(tx, labelledContract);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    // Read in a new transaction: neither resolution may depend on the writer's temporary selection.
    await owner.transaction('snapshot', async tx => {
      for (const [index, slot] of [{ subject: kept, property: 'label' }, { subject: retired, property: '$exists' }].entries()) {
        const at = new Date().toISOString();
        const question = await readDispute(tx, labelledContract, await loadAssertions(tx, 'vertex', 'fixture.page', [slot.property], [Number(slot.subject.id)]), { validAt: at, recordedAt: at, contexts: [1] });
        expect(question?.state).toBe('RESOLVED');
        expect(question?.resolution).toBe(resolutions[index]);
      }
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, tx, undefined, labelledGenerated, undefined, owner.graphContract);
      const page = await reader.list('fixture.page', { limit: 1 });
      expect(page.rows.map(row => [row.key, row.label])).toEqual([['fixture.page:kept', 'Chosen title']]);
      expect(page.total).toBe(1);
      expect(page.next).toBeNull();
      expect((await reader.find('fixture.page:kept'))[0]?.label).toBe('Chosen title');
      expect(await reader.find('fixture.page:retired')).toEqual([]);
      const searched = await reader.list('fixture.page', { limit: 1, q: ' CHOSEN ' });
      expect(searched.rows).toEqual(page.rows);
      expect(searched.total).toBe(1);
      expect(searched.next).toBeNull();
      for (const q of ['Rejected title', 'Retired title', 'no match']) {
        expect(await reader.list('fixture.page', { limit: 1, q })).toEqual({ rows: [], next: null, total: 0 });
      }
      expect(await reader.list('fixture.page', { limit: 1, after: 'fixture.page:kept' })).toEqual({ rows: [], next: null, total: 1 });
    });
  } finally { await owner.close(); }
});

test('generated page search uses the rendered label across several language and source slots', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: labelledContract });
  try {
    const first = await testHostBinding(owner, labelledContract, 'label-first');
    const second = await testHostBinding(owner, labelledContract, 'label-second');
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, labelledContract, first);
      await publishGraphDrafts(tx, labelledContract, {
        vertices: [{ kind: 'fixture.page', key: { slug: 'multilingual' }, values: { body: 'Page body' }, producer: 'fixture', producerVersion: '1' }], removals: [],
      });
      const subject = (await tx.query<{ id: string }>("SELECT n.id::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.page'")).rows[0]!;
      for (const [language, value] of [['en', 'English title'], ['ru', 'Russian title']] as const) {
        await writeAssertion(tx, labelledContract, { sort: 'vertex', kind: 'fixture.page', subjectId: subject.id, property: 'label', operation: 'assert', language, value });
      }
      await activateGraphProducer(tx, labelledContract, second);
      await writeAssertion(tx, labelledContract, { sort: 'vertex', kind: 'fixture.page', subjectId: subject.id, property: 'label', operation: 'assert', language: 'en', value: 'Rival English title' });
      await writeAssertion(tx, labelledContract, { sort: 'vertex', kind: 'fixture.page', subjectId: subject.id, property: 'label', operation: 'assert', language: 'de', value: 'Rendered Deutsch' });
    });
    await owner.transaction('snapshot', async tx => {
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, tx, undefined, labelledGenerated, undefined, owner.graphContract);
      const found = (await reader.find('fixture.page:multilingual'))[0]!;
      expect(found.label).toBe('Rendered Deutsch');
      expect(found.opinions?.filter(row => row.field === 'label').map(row => [row.lang, row.value, row.producer])).toEqual([
        ['en', 'English title', first.sourceUid], ['ru', 'Russian title', first.sourceUid], ['en', 'Rival English title', second.sourceUid], ['de', 'Rendered Deutsch', second.sourceUid],
      ]);
      const page = await reader.list('fixture.page', { limit: 1 });
      expect(page.rows).toEqual([found]);
      expect(page.total).toBe(1);
      expect(page.next).toBeNull();
      const searched = await reader.list('fixture.page', { limit: 1, q: '  DEUTSCH  ' });
      expect(searched).toEqual(page);
      for (const q of ['English title', 'Rival English title', 'Russian title', 'no match']) {
        expect(await reader.list('fixture.page', { limit: 1, q })).toEqual({ rows: [], next: null, total: 0 });
      }
      expect(await reader.list('fixture.page', { limit: 1, q: 'Deutsch', after: found.key })).toEqual({ rows: [], next: null, total: 1 });
    });
  } finally { await owner.close(); }
});
