/** The one typed assertion writer: decision 0039 items 1, 14–16, 25–28. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { assertionValueTableName, generatedTableName, type GraphContract, type VertexDraft } from '../src/graph/contract.js';
import { ensureVertex, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { loadAssertions, selectAssertionSlots } from '../src/graph/assertion-read.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const graph: GraphContract = {
  vertex: [{ name: 'fixture.term', table: generatedTableName('fixture.term', 'vertex'), key: ['name'],
    fields: [{ name: 'name', type: 'text' }, { name: 'definition', type: 'text', nullable: true }, { name: 'amount', type: 'integer', nullable: true }], capability: 'fixture' },{name:'fixture.snapshot',table:generatedTableName('fixture.snapshot','vertex'),key:['digest'],fields:[{name:'digest',type:'text'},{name:'content',type:'text'}],capability:'fixture',evidence:{immutable:true,digestField:'digest',contentField:'content',digestAlgorithm:'sha256'}}],
  edge: [{ name: 'fixture.links', from: ['fixture.term'], to: ['fixture.term'], repeats: true, discriminator: 'place',
    cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links to', in: 'linked from' }, ru: { out: 'ссылается', in: 'ссылка из' } },
    fields: [{ name: 'weight', type: 'integer', nullable: true }], capability: 'fixture' }], dictionary: [],
};
const ref = (name: string) => ({ kind: 'fixture.term', key: { name } });
const term = (name: string, definition = 'one'): VertexDraft => ({ ...ref(name), values: { definition }, producer: 'untrusted-string', producerVersion: '1' });
const otherSource = '019a0000-0000-7000-8000-000000000004';

async function fixture(work: (owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>) => Promise<void>) {
  const owner = await createTestDatabaseOwner({ graphContract: graph, authenticated: false });
  try { await work(owner); } finally { await owner.close(); }
}
async function selected(owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>, field = 'definition') {
  return await owner.transaction('snapshot', async tx => {
    const assertions = await loadAssertions(tx, 'vertex', 'fixture.term', [field]);
    const now = new Date().toISOString();
    return [...selectAssertionSlots(assertions, { validAt: now, recordedAt: now, contexts: [1] }).values()];
  });
}

test('0039.26: an unauthenticated producer cannot write even with a supplied producer string', async () => {
  await fixture(async owner => {
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, graph, { vertices: [term('a')], removals: [] }))).rejects.toThrow('AUTH_REQUIRED');
    expect((await owner.run(tx => tx.query('SELECT * FROM assertion'))).rows).toEqual([]);
  });
});

test('0039.25: key fields remain identity; values are typed per-property assertions with graph source lineage', async () => {
  await fixture(async owner => {
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [term('a')], removals: [] }); });
    const rows = await owner.run(tx => loadAssertions(tx, 'vertex', 'fixture.term', ['definition']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: TEST_SOURCE_UID, property: 'definition', value: 'one', operation: 'assert' });
    const key = await owner.run(tx => tx.query<{ key: unknown }>("SELECT key FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.term'"));
    expect(key.rows).toEqual([{ key: { name: 'a' } }]);
    const columns = await owner.run(tx => tx.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position', [assertionValueTableName('fixture.term', 'vertex', 'definition')]));
    expect(columns.rows.map(r => r.column_name)).toEqual(['assertion_id', 'value']);
  });
});

test('0039.14–16: a source change appends history and a second source never overwrites it', async () => {
  await fixture(async owner => {
    for (const [source, value] of [[TEST_SOURCE_UID, 'first'], [TEST_SOURCE_UID, 'second'], [otherSource, 'theirs']] as const) {
      await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph, source); await publishGraphDrafts(tx, graph, { vertices: [term('a', value)], removals: [] }); });
    }
    const history = await owner.run(tx => loadAssertions(tx, 'vertex', 'fixture.term', ['definition']));
    expect(history.map(a => [a.source, a.value])).toEqual([[TEST_SOURCE_UID, 'first'], [TEST_SOURCE_UID, 'second'], [otherSource, 'theirs']]);
    const slots = await selected(owner);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.selected!.value).toBe('theirs');
    expect(slots[0]!.contested).toBe(true);
  });
});

test('0039.26: a source retraction masks its own stream, not another source', async () => {
  await fixture(async owner => {
    for (const source of [TEST_SOURCE_UID, otherSource]) await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph, source); await publishGraphDrafts(tx, graph, { vertices: [term('a', source)], removals: [] }); });
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [], removals: [{ ...ref('a'), producer: 'forged-other', selectedFields: ['definition'] }] }); });
    expect((await selected(owner))[0]!.selected!.source).toBe(otherSource);
    expect((await owner.run(tx => loadAssertions(tx, 'vertex', 'fixture.term', ['definition']))).map(a => a.operation)).toEqual(['assert', 'assert', 'retract']);
  });
});

test.each([['definition', 3], ['amount', 'three'], ['amount', 2147483648]] as const)('0039.7: invalid %s=%s rolls back all identities and assertions', async (field, value) => {
  await fixture(async owner => {
    await expect(owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [{ ...term('bad'), values: { [field]: value } }], removals: [] }); })).rejects.toThrow('TYPE_MISMATCH');
    expect((await owner.run(tx => tx.query('SELECT * FROM node'))).rows).toEqual([]);
    expect((await owner.run(tx => tx.query('SELECT * FROM assertion'))).rows).toEqual([]);
  });
});

test('0039.24: failure after an accepted assertion rolls the whole operation back', async () => {
  await fixture(async owner => {
    await expect(owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [term('a')], removals: [] }); throw new Error('abort operation'); })).rejects.toThrow('abort operation');
    expect((await owner.run(tx => tx.query('SELECT * FROM node'))).rows).toEqual([]);
    expect((await owner.run(tx => tx.query('SELECT * FROM assertion'))).rows).toEqual([]);
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [term('a')], removals: [] }); const first = await ensureVertex(tx, graph, ref('a')); const second = await ensureVertex(tx, graph, ref('a')); expect(first.nodeId).toBe(second.nodeId); });
  });
});

test('0039.25: keyless identities are independent births and explicit uid preserves an identity', async () => {
  const contract: GraphContract = { ...graph, vertex: [...graph.vertex, { name: 'fixture.idea', table: 'unused', key: [], fields: [], capability: 'fixture' }] };
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      const a = await ensureVertex(tx, contract, { kind: 'fixture.idea', key: {} });
      const b = await ensureVertex(tx, contract, { kind: 'fixture.idea', key: {} });
      expect(a.uid).not.toBe(b.uid);
      expect((await ensureVertex(tx, contract, { kind: 'fixture.idea', key: {}, uid: a.uid })).nodeId).toBe(a.nodeId);
    });
  } finally { await owner.close(); }
});

test('0039.1: missing and wrong-kind edge endpoints refuse the entire operation, not an unresolved side table', async () => {
  await fixture(async owner => {
    await expect(owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [term('a')], removals: [], edges: [{ kind: 'fixture.links', from: ref('a'), to: ref('missing'), producer: 'fixture', producerVersion: '1' }] }); })).rejects.toThrow('MISSING_ENDPOINT');
    expect((await owner.run(tx => tx.query('SELECT * FROM node'))).rows).toEqual([]);
    const tables = await owner.run(tx => tx.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema()"));
    expect(tables.rows.map(r => r.name)).not.toContain('unresolved_reference');
  });
});

test('0039.25: edge existence and properties have edge subjects and the same typed lineage as vertices', async () => {
  await fixture(async owner => {
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [term('a'), term('b')], removals: [], edges: [{ kind: 'fixture.links', from: ref('a'), to: ref('b'), discriminator: 'one', values: { weight: 7 }, producer: 'fixture', producerVersion: '1' }] }); });
    const rows = await owner.run(tx => loadAssertions(tx, 'edge', 'fixture.links', ['$exists', 'weight']));
    expect(rows.map(a => [a.property, a.value, a.source]).sort()).toEqual([['$exists', true, TEST_SOURCE_UID], ['weight', 7, TEST_SOURCE_UID]]);
    const subjects = await owner.run(tx => tx.query('SELECT * FROM assertion_edge_subject'));
    expect(subjects.rows).toHaveLength(2);
  });
});

test('0039.14: evidence names a real vertex and missing evidence rolls back the write', async () => {
  await fixture(async owner => {
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [{kind:'fixture.snapshot',key:{digest:'b685bd8d6164b5c255df9af9d40e33f88087ae8ba5020fe301678183adbc1f60'},values:{content:'evidence text\nsecond line'},producer:'fixture',producerVersion:'1'}], removals: [] }); });
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [{ ...term('cited'), evidence: [{ target: {kind:'fixture.snapshot',key:{digest:'b685bd8d6164b5c255df9af9d40e33f88087ae8ba5020fe301678183adbc1f60'}}, relation: 'supports', locator: { lineStart: 1, lineEnd: 2 } }] }], removals: [] }); });
    const lineage = await owner.run(tx => tx.query<{ property: string }>("SELECT a.property FROM edge e JOIN entity k ON k.id=e.entity_id JOIN assertion a ON a.assertion_id=e.from_node WHERE k.name='system.assertion-evidence' ORDER BY a.property"));
    expect(lineage.rows).toEqual([{ property: '$exists' }, { property: 'definition' }, { property: 'name' }]);
    await expect(owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [{ ...term('invalid'), evidence: [{ target: {kind:'fixture.snapshot',key:{digest:'missing'}} }] }], removals: [] }); })).rejects.toThrow('MISSING_ENDPOINT');
    expect((await owner.run(tx => tx.query("SELECT * FROM node WHERE key->>'name'='invalid'"))).rows).toEqual([]);
  });
});

test('0039.14: evidence locators use their target content amid newer unrelated history', async () => {
  await fixture(async owner => {
    const snapshot = (content: string): VertexDraft => ({ kind: 'fixture.snapshot', key: { digest: createHash('sha256').update(content).digest('hex') }, values: { content }, producer: 'fixture', producerVersion: '1' });
    const target = snapshot('one line');
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [target, snapshot('newer\nunrelated\ncontent')], removals: [] });
    });
    await expect(owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [{ ...term('outside-target'), evidence: [{ target, locator: { lineStart: 1, lineEnd: 2 } }] }], removals: [] });
    })).rejects.toThrow('EVIDENCE_INVALID locator outside immutable content');
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [{ ...term('inside-target'), evidence: [{ target, locator: { lineStart: 1, lineEnd: 1, digest: String(target.key['digest']) } }] }], removals: [] });
    });
    const attachments = await owner.run(tx => tx.query<{ count: string }>("SELECT count(*)::text AS count FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.assertion-evidence'"));
    expect(attachments.rows).toEqual([{ count: '3' }]);
  });
});

test('0039.25: existing identity conflicts and immutable key changes still refuse', async () => {
  await fixture(async owner => {
    let uid = '';
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [term('original')], removals: [] });
      const first = await ensureVertex(tx, graph, ref('original'));
      uid = first.uid;
      expect((await ensureVertex(tx, graph, { ...ref('original'), uid })).nodeId).toBe(first.nodeId);
    });
    await expect(owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await ensureVertex(tx, graph, { ...ref('different'), uid });
    })).rejects.toThrow('UID_IDENTITY_CONFLICT');
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      const subject = await ensureVertex(tx, graph, ref('original'));
      await expect(writeAssertion(tx, graph, { sort: 'vertex', kind: 'fixture.term', subjectId: subject.nodeId, property: 'name', operation: 'assert', value: 'different' })).rejects.toThrow('IMMUTABLE_KEY');
    });
    const names = await owner.run(tx => tx.query<{ name: string }>("SELECT n.key->>'name' AS name FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.term'"));
    expect(names.rows).toEqual([{ name: 'original' }]);
  });
});

test('0039.25: an existing UID with a conflicting stored key is refused before finalization', async () => {
  await fixture(async owner => {
    const rollback = new Error('roll back conflicting fixture identity');
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); });
    let uid = '';
    await expect(owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      uid = (await ensureVertex(tx, graph, ref('original'))).uid;
      throw rollback;
    })).rejects.toBe(rollback);
    await expect(owner.transaction('write', async tx => {
      const binding = await bindTestWriteCapability(tx, graph);
      // Model a persisted UID conflict; the malformed fixture is always rolled back.
      await tx.query(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id)
        SELECT id,$1::uuid,$2::jsonb,$3::uuid,1 FROM entity WHERE name='fixture.term'`,
        [uid, JSON.stringify({ name: 'different' }), binding.productUid]);
      await expect(ensureVertex(tx, graph, ref('original'))).rejects.toThrow('UID_IDENTITY_CONFLICT');
      throw rollback;
    })).rejects.toBe(rollback);
  });
});

test('0039.25: time intervals are checked and recorded sequence is assigned by storage', async () => {
  await fixture(async owner => {
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [{ ...ref('a'), values: {}, producer: 'fixture', producerVersion: '1' }], removals: [] }); const node = await ensureVertex(tx, graph, ref('a')); await writeAssertion(tx, graph, { kind: 'fixture.term', sort: 'vertex', subjectId: node.nodeId, property: 'definition', operation: 'assert', value: 'historical', validFrom: '2020-01-01T00:00:00Z', validTo: '2021-01-01T00:00:00Z' }); });
    const rows = await owner.run(tx => loadAssertions(tx, 'vertex', 'fixture.term', ['definition']));
    expect(rows[0]!.recordedSequence > 0n).toBe(true);
    expect((await selected(owner))[0]?.selected ?? null).toBeNull();
    await expect(owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); const node = await ensureVertex(tx, graph, ref('a')); await writeAssertion(tx, graph, { kind: 'fixture.term', sort: 'vertex', subjectId: node.nodeId, property: 'definition', operation: 'assert', value: 'bad', validFrom: '2021-01-01T00:00:00Z', validTo: '2020-01-01T00:00:00Z' }); })).rejects.toThrow();
    expect(await owner.run(tx => loadAssertions(tx, 'vertex', 'fixture.term', ['definition']))).toHaveLength(1);
  });
});
