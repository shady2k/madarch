/**
 * The current-values mode of the one assertion read (decision 0039 item 25): a caller that only reads the selected
 * assertion of each stream and the ones that still stand asks for those rows alone, and gets exactly what the
 * history read returns once filtered to the same rows. The mode is a filter and a later attachment, never a second
 * selection rule.
 */
import { expect, test } from 'bun:test';
import { loadAssertionsBatch, type AssertionReadRequest, type AssertionSqlSelector, type StoredAssertion } from '../src/graph/assertion-read.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { pinContext } from '../src/graph/context.js';
import { bindWriteCapability, bootstrapWriteIdentity, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const SECOND_SOURCE = '019a0000-0000-7000-8000-000000000004';
const unitUids = ['019a0000-0000-7000-8000-000000000011', '019a0000-0000-7000-8000-000000000012'];
const contract: GraphContract = {
  vertex: ['sample', 'code.repository'].map(name => ({ name, table: generatedTableName(name, 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'note', type: 'text' as const, nullable: true }], capability: 'fixture' })),
  edge: [{ name: 'sample-repository', from: ['sample'], to: ['code.repository'], repeats: false, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'repository', in: 'sample' }, ru: { out: 'repository', in: 'sample' } }, fields: [], capability: 'fixture' }],
  dictionary: [],
};

const shape = (rows: readonly StoredAssertion[]): string[] => rows.map(row => JSON.stringify(row));

/** History, then the same read filtered to the rows a current-value answer is made of. */
async function compare(tx: SqlExecutor, requests: readonly AssertionReadRequest[], selector: AssertionSqlSelector): Promise<number> {
  const history = await loadAssertionsBatch(tx, requests, selector);
  const current = await loadAssertionsBatch(tx, requests, { ...selector, currentValues: true });
  const kept = history.map(rows => shape(rows.filter(row => row.selected === true || row.active === true)));
  expect(shape(current.flat())).toEqual(kept.flat());
  expect(current.map(rows => rows.length)).toEqual(kept.map(rows => rows.length));
  return current.flat().length;
}

test('the current-values mode returns the history rows that are selected or active, and no others', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    const child = await owner.transaction('write', async tx => {
      for (let index = 0; index < 5; index++) await tx.query('SELECT graph_next_recorded_sequence()');
      const pinned = Number(await pinContext(tx, '1', 'current-values-child'));
      const binding = await bindTestWriteCapability(tx, contract);
      for (const unit of unitUids) await bootstrapWriteIdentity(tx, 'system.unit', unit, binding.productUid);
      bindWriteCapability(tx, { ...binding, unitUid: unitUids[0]! });
      await publishGraphDrafts(tx, contract, {
        vertices: [
          ...['one', 'two'].map(name => ({ kind: 'sample', key: { name }, values: { note: name }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })),
          { kind: 'code.repository', key: { name: 'example' }, values: { note: 'repository' }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' },
        ],
        edges: ['one', 'two'].map(name => ({ kind: 'sample-repository', from: { kind: 'sample', key: { name } }, to: { kind: 'code.repository', key: { name: 'example' } }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })),
        removals: [],
      });
      const members = (await tx.query<{ id: number; uid: string }>("SELECT n.id,n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.id")).rows;
      const first = String(members[0]!.id);
      // One subject carries history: versions in two sources, two languages, a retraction and a child-context value.
      for (const [index, validFrom] of ['2020-01-01', '2021-01-01', '2022-01-01'].entries()) {
        await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: first, property: 'note', value: `version ${String(index)}`, operation: 'assert', validFrom });
      }
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: first, property: 'note', value: 'english', operation: 'assert', validFrom: '2023-01-01', language: 'en' });
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: first, property: 'note', value: 'withdrawn', operation: 'assert', validFrom: '2024-01-01' });
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: first, property: 'note', operation: 'retract', validFrom: '2025-01-01' });
      const second = await bindTestWriteCapability(tx, contract, SECOND_SOURCE);
      bindWriteCapability(tx, { ...second, unitUid: unitUids[1]! });
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: first, property: 'note', value: 'other source', operation: 'assert', validFrom: '2026-01-01' });
      const inheritedBinding = await bindTestWriteCapability(tx, contract, TEST_SOURCE_UID, pinned);
      bindWriteCapability(tx, { ...inheritedBinding, unitUid: unitUids[0]! });
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: first, property: 'note', value: 'inherited', operation: 'assert', validFrom: '2020-01-01' }, pinned);
      // A merge projects both members onto their survivor, which changes the subject a row is answered for.
      const merge = { kind: 'system.merge', key: {}, uid: crypto.randomUUID() };
      bindWriteCapability(tx, { ...second, unitUid: unitUids[1]! });
      await publishGraphDrafts(tx, contract, {
        vertices: [{ ...merge, values: { state: 'ACTIVE', reason: 'Same entity checked' }, producer: 'fixture', producerVersion: '1' }],
        edges: [
          ...members.map(member => ({ kind: 'system.merge-member', from: merge, to: { kind: 'sample', key: {}, uid: member.uid }, discriminator: member.uid, producer: 'fixture', producerVersion: '1' })),
          { kind: 'system.merge-survivor', from: merge, to: { kind: 'sample', key: {}, uid: members[0]!.uid }, discriminator: members[0]!.uid, producer: 'fixture', producerVersion: '1' },
        ],
        removals: [],
      });
      return pinned;
    });
    await owner.transaction('snapshot', async tx => {
      const ids = (await tx.query<{ id: number }>("SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.id")).rows.map(row => Number(row.id));
      const assertionIds = (await tx.query<{ uid: string }>("SELECT n.uid::text FROM node n JOIN assertion a ON a.assertion_id=n.id WHERE a.property='note' ORDER BY n.uid::text COLLATE \"C\"")).rows.map(row => row.uid);
      const requests: readonly AssertionReadRequest[] = [
        { sort: 'vertex', kind: 'sample', properties: ['$exists', 'name', 'note'], repositoryKinds: ['sample-repository'] },
        { sort: 'vertex', kind: 'sample', properties: ['note'], subjectIds: ids, repositoryKinds: ['sample-repository'] },
        { sort: 'edge', kind: 'sample-repository', properties: ['$exists'] },
      ];
      const at = '2030-01-01T00:00:00Z';
      let answered = 0;
      for (const selector of [
        {}, { diagnostics: true }, { validAt: at, recordedAt: at }, { validAt: '2021-06-01', recordedAt: at },
        { sourceUids: [TEST_SOURCE_UID] }, { sourceUids: [SECOND_SOURCE] }, { unitUids: [unitUids[0]!] },
        { resolvedAssertionIds: assertionIds.slice(0, 1) }, { contexts: [child], contextRecordedThrough: { [child]: '0' } },
      ] satisfies AssertionSqlSelector[]) {
        for (const projectMergedSubjects of [false, true]) answered += await compare(tx, requests, { ...selector, projectMergedSubjects });
      }
      // The history read is wider than the current-value read: the mode is a narrowing, not a rewrite.
      const history = await loadAssertionsBatch(tx, requests, {});
      const current = await loadAssertionsBatch(tx, requests, { currentValues: true });
      expect(history.flat().length).toBeGreaterThan(current.flat().length);
      expect(current.flat().every(row => row.selected === true || row.active === true)).toBe(true);
      expect(answered).toBeGreaterThan(0);
    });
  } finally { await owner.close(); }
}, 60_000);

test('a current-values read of one property costs the same lineage with one version and with fifty', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    await owner.transaction('write', async tx => {
      const binding = await bindTestWriteCapability(tx, contract);
      bindWriteCapability(tx, binding);
      await publishGraphDrafts(tx, contract, {
        vertices: ['once', 'many'].map(name => ({ kind: 'sample', key: { name }, values: { note: name }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })),
        removals: [],
      });
      const subjects = (await tx.query<{ id: number; name: string }>("SELECT n.id,n.key->>'name' AS name FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.id")).rows;
      for (const subject of subjects) {
        const versions = subject.name === 'many' ? 50 : 1;
        for (let index = 0; index < versions; index++) {
          await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: String(subject.id), property: 'note', value: `${subject.name} ${String(index)}`, operation: 'assert', validFrom: `20${String(10 + index).padStart(2, '0')}-01-01` });
        }
      }
    });
    await owner.transaction('snapshot', async tx => {
      const subjects = (await tx.query<{ id: number; name: string }>("SELECT n.id,n.key->>'name' AS name FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.id")).rows;
      const at = '2030-01-01T00:00:00Z';
      interface PlanNode { 'Relation Name'?: string; 'Alias'?: string; 'Actual Rows': number; 'Actual Loops': number; Plans?: PlanNode[] }
      const lineage = (node: PlanNode): number => (node['Relation Name'] === 'edge' && node['Alias'] === 'lineage' ? node['Actual Rows'] * node['Actual Loops'] : 0) + (node.Plans ?? []).reduce((sum, child) => sum + lineage(child), 0);
      const measured: number[] = [];
      for (const subject of subjects) {
        const read = await loadAssertionsBatch({ query: async <Row extends object>(sql: string, parameters?: readonly unknown[]) => {
          const result = await tx.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, parameters);
          measured.push(lineage(result.rows[0]!['QUERY PLAN'][0]!.Plan));
          return { rows: [] as Row[] };
        } }, [{ sort: 'vertex', kind: 'sample', properties: ['note'], subjectIds: [Number(subject.id)] }], { validAt: at, recordedAt: at, currentValues: true });
        expect(read).toEqual([[]]);
      }
      // The selected row of a stream is one row whatever its history: the lineage read does not grow with versions.
      expect(measured[0]).toBeGreaterThan(0);
      expect(measured[1]).toBe(measured[0]);
    });
  } finally { await owner.close(); }
}, 60_000);
