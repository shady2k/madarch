import { createHash } from 'node:crypto';
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { pinContext } from '../src/graph/context.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const producer = { producer: 'fixture', producerVersion: '1' };
const labels = { en: { out: 'relates to', in: 'related from' }, ru: { out: 'связан с', in: 'связь из' } };
const otherSource = '019a0000-0000-7000-8000-000000000004';
const key = { name: 'name', type: 'text' } as const;
const text = { name: 'text', type: 'text' } as const;
const graph: GraphContract = {
  vertex: [
    { name: 'retire.root', table: generatedTableName('retire.root','vertex'), key: ['name'], fields: [key, text], capability: 'fixture' },
    ...(['cascade', 'restrict'] as const).map(onDelete => ({
      name: 'retire.' + onDelete, table: generatedTableName('retire.' + onDelete,'vertex'), key: ['name'], fields: [key],
      keyEdges: [{ role: 'root', edge: 'retire.' + onDelete + '-root', direction: 'from' as const, onDelete }], capability: 'fixture',
    })),
    { name: 'retire.snapshot', table: generatedTableName('retire.snapshot','vertex'), key: ['digest'],
      fields: [{ name: 'digest', type: 'text' }, { name: 'content', type: 'text' }], capability: 'fixture',
      evidence: { immutable: true, digestField: 'digest', contentField: 'content', digestAlgorithm: 'sha256' } },
  ],
  edge: [
    ...(['cascade', 'restrict'] as const).map(kind => ({
      name: 'retire.' + kind + '-root', from: ['retire.' + kind], to: ['retire.root'], fields: [], labels,
      repeats: false, cardinality: { from: 'many' as const, to: 'one' as const }, capability: 'fixture',
    })),
    { name: 'retire.link', from: ['retire.root'], to: ['retire.root'], fields: [text], labels,
      repeats: false, cardinality: { from: 'many', to: 'many' }, capability: 'fixture' },
  ],
  dictionary: [],
};
const root = (name: string) => ({ kind: 'retire.root', key: { name }, ...producer });
const child = (kind: 'cascade' | 'restrict', parent: ReturnType<typeof root>) => ({
  kind: 'retire.' + kind, key: { name: kind }, keyEdges: { root: parent }, ...producer,
});

test('batch retirement keeps language streams, prior valid and recorded views, and immutable evidence', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: graph, authenticated: false });
  try {
    const a = root('a'), b = root('b'), c = root('c');
    const content = 'One immutable line.';
    const snapshot = { kind: 'retire.snapshot', key: { digest: createHash('sha256').update(content).digest('hex') }, ...producer };
    const evidence = [{ target: snapshot, locator: { start: 0, end: 3 } }];
    const link = { kind: 'retire.link', from: a, to: b, ...producer };
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      const validFrom = '2020-01-01T00:00:00Z';
      for (const lang of ['en', 'ru']) await publishGraphDrafts(tx, graph, {
        vertices: [{ ...snapshot, values: { content }, validFrom }, ...[a, b, c].map(ref => ({ ...ref, values: { text: lang }, lang, validFrom, evidence }))],
        edges: [{ ...link, values: { text: lang }, lang, validFrom, evidence }], removals: [],
      });
      await bindTestWriteCapability(tx, graph, otherSource);
      await publishGraphDrafts(tx, graph, {
        vertices: [a, b].map(ref => ({ ...ref, values: { text: 'theirs' }, lang: 'en', validFrom })),
        edges: [{ ...link, values: { text: 'theirs' }, lang: 'en', validFrom }], removals: [],
      });
    });
    const { branch, recordedAt } = await owner.transaction('write', async tx => ({
      branch: Number(await pinContext(tx, '1', 'before-retirement')),
      recordedAt: (await tx.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at,
    }));
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      expect(await publishGraphDrafts(tx, graph, { vertices: [], removals: [{ ...a, evidence }, { ...b, evidence }, { ...c, evidence }] })).toBe(3);
    });
    await owner.run(async tx => {
      const validAt = '2099-01-01T00:00:00Z';
      for (const [sort, kind, expected] of [['vertex', 'retire.root', 3], ['edge', 'retire.link', 1]] as const) {
        const read = (at: string, recorded?: string, context = 1) =>
          loadAssertions(tx, sort, kind, ['text', '$exists'], undefined, { validAt: at, recordedAt: recorded, contexts: [context] });
        const before = await read('2021-01-01T00:00:00Z');
        const countOwn = (rows: typeof before, language: string) =>
          rows.filter(row => row.active && row.source === TEST_SOURCE_UID && row.property === 'text' && row.language === language).length;
        expect(countOwn(before, 'en')).toBe(expected);
        expect(countOwn(before, 'ru')).toBe(expected);
        expect(countOwn(await read(validAt, recordedAt), 'ru')).toBe(expected);
        expect(countOwn(await read(validAt, undefined, branch), 'ru')).toBe(expected);
        const after = await read(validAt);
        expect(countOwn(after, 'en')).toBe(0);
        expect(countOwn(after, 'ru')).toBe(0);
        expect(after.filter(row => row.active && row.source === otherSource && row.property === 'text').map(row => row.value))
          .toEqual(sort === 'vertex' ? ['theirs', 'theirs'] : ['theirs']);
        const retractions = after.filter(row => row.operation === 'retract' && row.property === 'text');
        // The link stays active for the other source, so both of its endpoint removals withdraw the caller's streams.
        expect(retractions).toHaveLength(sort === 'vertex' ? 6 : 4);
        for (const row of retractions) expect(row.evidenceAttachments).toHaveLength(1);
        expect(after.filter(row => row.operation === 'assert' && row.property === 'text' && row.source === TEST_SOURCE_UID)
          .every(row => row.evidenceAttachments.length === 1)).toBe(true);
      }
      expect((await loadAssertions(tx, 'vertex', 'retire.snapshot', ['content'])).map(row => row.value)).toEqual([content]);
    });
  } finally { await owner.close(); }
});

test('batch retirement honours earlier removals before RESTRICT and rolls back a mid-batch refusal', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: graph, authenticated: false });
  try {
    const first = root('first'), protectedRoot = root('protected'), cascadingRoot = root('cascading');
    const protectedChild = child('restrict', protectedRoot), cascadingChild = child('cascade', cascadingRoot);
    const retire = (removals: Parameters<typeof publishGraphDrafts>[2]['removals']) =>
      owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, graph);
        return await publishGraphDrafts(tx, graph, { vertices: [], removals });
      });
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [first, protectedRoot, protectedChild, cascadingRoot, cascadingChild], removals: [] });
    });
    const history = async () => await owner.run(async tx => (await tx.query<{ kind: string; name: string }>(
      `SELECT k.name AS kind, n.key->>'name' AS name FROM assertion a JOIN assertion_vertex_subject s USING(assertion_id)
       JOIN edge e ON e.id=s.subject_edge_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id
       WHERE a.operation='retract' AND a.property='$exists' ORDER BY a.recorded_sequence`,
    )).rows);
    await expect(retire([first, cascadingRoot, protectedRoot])).rejects.toThrow('PARENT_DELETE_RESTRICTED retire.restrict.root');
    expect(await history()).toEqual([]);
    expect(await retire([first, protectedChild, protectedRoot, cascadingRoot])).toBe(4);
    expect(await history()).toEqual([
      { kind: 'retire.root', name: 'first' },
      { kind: 'retire.restrict', name: 'restrict' },
      { kind: 'retire.root', name: 'protected' },
      { kind: 'retire.cascade', name: 'cascade' },
      { kind: 'retire.root', name: 'cascading' },
    ]);
  } finally { await owner.close(); }
});

async function measure(count: number) {
  const owner = await createTestDatabaseOwner({ graphContract: graph, authenticated: false });
  try {
    const roots = Array.from({ length: count }, (_, i) => root('retired-' + i));
    const anchor = root('kept');
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, {
        vertices: [anchor, ...roots], edges: roots.map(from => ({ kind: 'retire.link', from, to: anchor, ...producer })), removals: [],
      });
      // Unrelated assertions live in the same property and source as the outgoing roots.
      await publishGraphDrafts(tx, graph, {
        vertices: Array.from({ length: 200 }, (_, i) => ({ ...root('history-' + i), values: { text: 'past' }, lang: 'en' })), removals: [],
      });
    });
    return await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      const query = tx.query.bind(tx);
      const languageCalls: { sql: string; parameters?: readonly unknown[] }[] = [];
      let statements = 0, preparations = 0;
      const original = crypto.createHash;
      const spy = spyOn(crypto, 'createHash').mockImplementation(((...args: Parameters<typeof createHash>) => {
        if (new Error().stack?.includes('preparePublicationContract')) preparations++;
        return original(...args);
      }) as typeof createHash);
      tx.query = async (sql, parameters) => {
        statements++;
        if (sql.includes('SELECT DISTINCT') && sql.includes('.language') && !sql.includes('recorded_sequence')) {
          languageCalls.push({ sql, parameters });
        }
        return await query(sql, parameters);
      };
      try {
        expect(await publishGraphDrafts(tx, graph, { vertices: [], removals: roots })).toBe(count);
      } finally {
        tx.query = query;
        spy.mockRestore();
      }
      expect(languageCalls.length).toBeGreaterThan(0);
      expect(languageCalls.length).toBeLessThanOrEqual(2);
      for (const { sql, parameters } of languageCalls) {
        const result = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
        type Plan = { 'Relation Name'?: string; 'Node Type': string; 'Index Cond'?: string; Plans?: Plan[] };
        const plans = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(plans)];
        const headers = plans((result.rows[0]!['QUERY PLAN'] as { Plan: Plan }[])[0]!.Plan)
          .filter(node => node['Relation Name'] === 'assertion');
        expect(headers.length).toBeGreaterThan(0);
        for (const header of headers) {
          expect(header['Node Type']).toContain('Index');
          expect(header['Index Cond']).toContain('assertion_id');
        }
      }
      return { statements, preparations, languageCalls: languageCalls.length };
    });
  } finally { await owner.close(); }
}

test('independent retirements reuse the writer contract and bound language lookups to assertion identities', async () => {
  const small = await measure(3);
  const large = await measure(40);
  expect(large).toEqual(small);
  expect(large.preparations).toBeLessThanOrEqual(1);
  expect(large.statements).toBeLessThanOrEqual(12);
});
