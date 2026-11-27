/** The one typed assertion writer: decision 0039 items 1, 14–16, 25–28. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { assertionValueTableName, generatedTableName, type GraphContract, type VertexDraft } from '../src/graph/contract.js';
import { ensureVertex, publishGraphDrafts, writeAssertion, resolveEntityRef, resolveEntityRefs, bindWriteCapability, requireWriteCapability } from '../src/graph/write.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import type { SqlExecutor } from '../src/sql-driver.js';
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
    const now = new Date().toISOString();
    const assertions = await loadAssertions(tx, 'vertex', 'fixture.term', [field], undefined, { validAt: now, recordedAt: now, contexts: [1] });
    const subjects = [...new Set(assertions.map(row=>row.subjectId))];
    return subjects.map(subjectId=>{
      const active = assertions.filter(row=>row.subjectId===subjectId && row.active);
      return {selected: active.find(row=>row.selected)??null, contested: new Set(active.map(row=>JSON.stringify(row.value))).size>1};
    });
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
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      const query=tx.query.bind(tx);const calls:string[]=[];
      tx.query=async (sql,values)=>{calls.push(sql);return await query(sql,values);};
      await publishGraphDrafts(tx, graph, { vertices: [term('a')], removals: [] });
      expect(calls.filter(sql=>sql.startsWith('SELECT n.id::text AS id,k.name AS kind,n.key,n.identity_scope'))).toHaveLength(0);
    });
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
    await expect(owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [{ ...term('bad'), values: { [field]: value } }], removals: [] }); })).rejects.toMatchObject({ code: 'SCHEMA_INVALID', path: `/values/${field}`, actual: value, retryable: false });
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


const wildcardGraph: GraphContract = {
  ...graph,
  edge: [...graph.edge, { ...graph.edge[0]!, name: 'mentions', from: ['any'], to: ['any'], repeats: false }],
};
const snapshot = (): VertexDraft => ({ kind: 'fixture.snapshot', key: { digest: createHash('sha256').update('record').digest('hex') }, values: { content: 'record' }, producer: 'fixture', producerVersion: '1' });
/**
 * The graph's own rows: the fixture commits its identity vertices before the case's first write (R4, ALX-464).
 * Whole rows, not counts, in the identity key's order (ALX-531): a refusal that changed a committed vertex or its
 * assertion keeps the counts and must still show here.
 */
const graphSnapshot = async (tx: SqlExecutor) => ({
  nodes: (await tx.query<Record<string, unknown>>('SELECT * FROM node ORDER BY entity_id, key, uid')).rows,
  assertions: (await tx.query<Record<string, unknown>>('SELECT * FROM assertion ORDER BY assertion_id')).rows,
});

test.each([false, true])('ALX-65: wildcard mentions writes different declared record kinds (reverse=%s)', async reverse => {
  const owner = await createTestDatabaseOwner({ graphContract: wildcardGraph });
  try {
    const [from, to] = reverse ? [snapshot(), term('a')] : [term('a'), snapshot()];
    await owner.transaction('write', tx => publishGraphDrafts(tx, wildcardGraph, {
      vertices: [from!, to!], removals: [], edges: [{ kind: 'mentions', from: from!, to: to!, producer: 'fixture', producerVersion: '1' }],
    }));
    const endpoints = await owner.run(tx => tx.query<{ from_kind: string; to_kind: string }>(`SELECT f.name AS from_kind,t.name AS to_kind
      FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node fn ON fn.id=e.from_node JOIN entity f ON f.id=fn.entity_id
      JOIN node tn ON tn.id=e.to_node JOIN entity t ON t.id=tn.entity_id WHERE k.name='mentions'`));
    expect(endpoints.rows).toEqual([{ from_kind: from!.kind, to_kind: to!.kind }]);
    const existence = await owner.run(tx => loadAssertions(tx, 'edge', 'mentions', ['$exists']));
    expect(existence).toHaveLength(1);
    expect(existence[0]).toMatchObject({ value: true, operation: 'assert', source: TEST_SOURCE_UID });
  } finally { await owner.close(); }
});

test('ALX-65: wildcard mentions accepts built-in system records on both ends', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: wildcardGraph });
  try {
    await owner.transaction('write', async tx => {
      const system = { kind: 'system.product', key: {}, uid: '019a0000-0000-7000-8000-000000000077' };
      await publishGraphDrafts(tx, wildcardGraph, {
        vertices: [term('a'), { ...system, producer: 'fixture', producerVersion: '1' }], removals: [],
        edges: [{ kind: 'mentions', from: ref('a'), to: system, producer: 'fixture', producerVersion: '1' },
          { kind: 'mentions', from: system, to: ref('a'), producer: 'fixture', producerVersion: '1' }],
      });
    });
    expect((await owner.run(tx => loadAssertions(tx, 'edge', 'mentions', ['$exists']))).map(row => row.value)).toEqual([true, true]);
  } finally { await owner.close(); }
});

test.each(['mentions', 'fixture.undeclared'])('ALX-65: wildcard mentions refuses non-record endpoint kind %s and rolls back', async kind => {
  const owner = await createTestDatabaseOwner({ graphContract: wildcardGraph });
  try {
    let before: Awaited<ReturnType<typeof graphSnapshot>> | undefined;
    await expect(owner.transaction('write', async tx => {
      // The refused write leaves the graph as it stood when the case's transaction began: the fixture's identity
      // vertices are already committed (R4, ALX-464), so the rows before the write are the rows after the refusal.
      before = await graphSnapshot(tx);
      await publishGraphDrafts(tx, wildcardGraph, {
        vertices: [term('a')], removals: [], edges: [{ kind: 'mentions', from: ref('a'), to: { kind, key: {} }, producer: 'fixture', producerVersion: '1' }],
      });
    })).rejects.toThrow(`UNKNOWN_KIND ${kind}`);
    expect(await owner.run(tx => graphSnapshot(tx))).toEqual(before!);
  } finally { await owner.close(); }
});

test('ALX-65: wildcard mentions still refuses a missing declared record and rolls back', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: wildcardGraph });
  try {
    let before: Awaited<ReturnType<typeof graphSnapshot>> | undefined;
    await expect(owner.transaction('write', async tx => {
      before = await graphSnapshot(tx);
      await publishGraphDrafts(tx, wildcardGraph, {
        vertices: [term('a')], removals: [], edges: [{ kind: 'mentions', from: ref('a'), to: ref('missing'), producer: 'fixture', producerVersion: '1' }],
      });
    })).rejects.toThrow('MISSING_ENDPOINT');
    expect(await owner.run(tx => graphSnapshot(tx))).toEqual(before!);
  } finally { await owner.close(); }
});


test('ALX-65: explicit relation ends still refuse a different declared record kind', async () => {
  await fixture(async owner => {
    await expect(owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [term('a'), snapshot()], removals: [],
        edges: [{ kind: 'fixture.links', from: ref('a'), to: snapshot(), producer: 'fixture', producerVersion: '1' }] });
    })).rejects.toThrow('ENDPOINT_KIND fixture.links');
    expect((await owner.run(tx => tx.query('SELECT * FROM node'))).rows).toEqual([]);
    expect((await owner.run(tx => tx.query('SELECT * FROM assertion'))).rows).toEqual([]);
  });
});

test('ALX-65: wildcard mentions refuses a declared kind spoofing another stored kind UID', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: wildcardGraph });
  try {
    const uid = await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, wildcardGraph, { vertices: [term('a'), snapshot()], removals: [] });
      return (await ensureVertex(tx, wildcardGraph, snapshot())).uid;
    });
    const before = (await owner.run(tx => tx.query('SELECT count(*)::text AS count FROM assertion'))).rows;
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, wildcardGraph, {
      vertices: [term('rolled-back')], removals: [],
      edges: [{ kind: 'mentions', from: ref('a'), to: { kind: 'fixture.term', key: {}, uid }, producer: 'fixture', producerVersion: '1' }],
    }))).rejects.toThrow('MISSING_ENDPOINT');
    expect((await owner.run(tx => tx.query("SELECT * FROM node WHERE key->>'name'='rolled-back'"))).rows).toEqual([]);
    expect((await owner.run(tx => tx.query('SELECT count(*)::text AS count FROM assertion'))).rows).toEqual(before);
    expect(await owner.run(tx => loadAssertions(tx, 'edge', 'mentions', ['$exists']))).toEqual([]);
  } finally { await owner.close(); }
});

test('0039.25: edge existence and properties have edge subjects and the same typed lineage as vertices', async () => {
  await fixture(async owner => {
    await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, graph); await publishGraphDrafts(tx, graph, { vertices: [term('a'), term('b')], removals: [], edges: [{ kind: 'fixture.links', from: ref('a'), to: ref('b'), discriminator: 'one', values: { weight: 7 }, producer: 'fixture', producerVersion: '1' }] }); });
    const rows = await owner.run(tx => loadAssertions(tx, 'edge', 'fixture.links', ['$exists', 'weight']));
    expect(rows.map(a => [a.property, a.value, a.source]).sort()).toEqual([['$exists', true, TEST_SOURCE_UID], ['weight', 7, TEST_SOURCE_UID]]);
    const endpoints = await owner.run(tx => tx.query<{ name: string; uid: string }>(`SELECT key->>'name' AS name,uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.term' AND key->>'name'=ANY($1::text[])`, [['a', 'b']]));
    expect(endpoints.rows.map(row => row.name).sort()).toEqual(['a', 'b']);
    const from = endpoints.rows.find(row => row.name === 'a')!.uid;
    const to = endpoints.rows.find(row => row.name === 'b')!.uid;
    const fixtureEdge = await owner.run(tx => tx.query<{ uid: string }>(`SELECT subject.uid::text AS uid
      FROM edge subject JOIN entity kind ON kind.id=subject.entity_id
      JOIN node edge_from ON edge_from.id=subject.from_node JOIN node edge_to ON edge_to.id=subject.to_node
      WHERE kind.name='fixture.links' AND subject.discriminator='one' AND edge_from.uid=$1::uuid AND edge_to.uid=$2::uuid`, [from, to]));
    expect(fixtureEdge.rows).toHaveLength(1);
    const edgeUid = fixtureEdge.rows[0]!.uid;
    const edgeSubjects = await owner.run(tx => tx.query<{ property: string; assertion_id: string; edge_uid: string }>(`SELECT a.property,assertion_node.uid::text AS assertion_id,subject.uid::text AS edge_uid
      FROM assertion_edge_subject attachment JOIN assertion a ON a.assertion_id=attachment.assertion_id JOIN node assertion_node ON assertion_node.id=a.assertion_id
      JOIN edge subject ON subject.id=attachment.edge_id JOIN entity kind ON kind.id=subject.entity_id
      JOIN node edge_from ON edge_from.id=subject.from_node JOIN node edge_to ON edge_to.id=subject.to_node
      WHERE kind.name='fixture.links' AND subject.discriminator='one' AND edge_from.uid=$1::uuid AND edge_to.uid=$2::uuid`, [from, to]));
    expect(edgeSubjects.rows.map(row => [row.property, row.assertion_id]).sort()).toEqual(rows.map(row => [row.property, row.id]).sort());
    expect(new Set(edgeSubjects.rows.map(row => row.edge_uid))).toEqual(new Set([edgeUid]));
    const outside = await owner.run(tx => tx.query<{ kind: string; property: string }>(`SELECT kind.name AS kind,a.property
      FROM assertion_edge_subject attachment JOIN assertion a ON a.assertion_id=attachment.assertion_id
      JOIN edge subject ON subject.id=attachment.edge_id JOIN entity kind ON kind.id=subject.entity_id
      JOIN node edge_from ON edge_from.id=subject.from_node JOIN node edge_to ON edge_to.id=subject.to_node
      WHERE NOT (kind.name='fixture.links' AND subject.discriminator='one' AND edge_from.uid=$1::uuid AND edge_to.uid=$2::uuid)`, [from, to]));
    expect(outside.rows).toEqual([{ kind: 'system.operation-author', property: '$exists' }]);
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


test('bulk identities survive retry and registrations do not survive rollback', async () => {
  await fixture(async owner => {
    const keys = ['batch-a', 'batch-b'];
    await expect(owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      for (const name of keys) await ensureVertex(tx, graph, ref(name));
      throw new Error('rollback registrations');
    })).rejects.toThrow('rollback registrations');
    expect((await owner.run(tx => tx.query("SELECT * FROM node WHERE key->>'name' IN ('batch-a','batch-b')"))).rows).toEqual([]);
    const create = async () => await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: keys.map(name => term(name)), removals: [] });
      const made = [];
      for (const name of keys) made.push(await ensureVertex(tx, graph, ref(name)));
      return made;
    });
    const first = await create();
    const again = await create();
    expect(again.map(node => [node.nodeId, node.uid])).toEqual(first.map(node => [node.nodeId, node.uid]));
    expect(new Set(first.map(node => node.uid)).size).toBe(2);
  });
});

test('bulk repeated edges keep shared endpoints, discriminators, typed values and rollback', async () => {
  await fixture(async owner => {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: ['a', 'b', 'c'].map(name => term(name)), removals: [] });
    });
    const edges = [
      { from: ref('a'), to: ref('b'), discriminator: 'first', values: { weight: 1 } },
      { from: ref('a'), to: ref('c'), discriminator: 'second', values: { weight: 2 } },
      { from: ref('a'), to: ref('b'), discriminator: 'third', values: { weight: 3 } },
    ].map(edge => ({ ...edge, kind: 'fixture.links', producer: 'fixture', producerVersion: '1' }));
    const publish = async (rollback = false) => await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [], edges, removals: [] });
      if (rollback) throw new Error('rollback edge batch');
    });
    const read = async () => await owner.run(tx => loadAssertions(tx, 'edge', 'fixture.links', ['$exists', 'weight']));
    await expect(publish(true)).rejects.toThrow('rollback edge batch');
    expect(await read()).toEqual([]);
    await publish();
    const first = await read();
    expect(first.filter(row => row.property === '$exists')).toHaveLength(3);
    expect(first.filter(row => row.property === 'weight').map(row => row.value).sort()).toEqual([1, 2, 3]);
    const identities = await owner.run(tx => tx.query<{ uid: string; discriminator: string }>("SELECT e.uid::text, e.discriminator FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='fixture.links' ORDER BY e.discriminator"));
    expect(identities.rows.map(row => row.discriminator)).toEqual(['first', 'second', 'third']);
    await publish();
    const repeated = await owner.run(tx => tx.query<{ uid: string; discriminator: string }>("SELECT e.uid::text, e.discriminator FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='fixture.links' ORDER BY e.discriminator"));
    expect(repeated.rows).toEqual(identities.rows);
    const now = new Date().toISOString();
    expect((await owner.run(tx => loadAssertions(tx, 'edge', 'fixture.links', ['$exists', 'weight'], undefined, { validAt: now, recordedAt: now, contexts: [1] }))).filter(row => row.selected)).toHaveLength(6);
  });
});

test('batched reference checks equal scalar checks, including duplicates, missing, inactive and scope refusals', async () => {
  await fixture(async owner => {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [term('a'), term('b')], removals: [] });
      const refs = [ref('a'), ref('b'), ref('a')];
      const scalar = await Promise.all(refs.map(one => resolveEntityRef(tx, graph, one)));
      const query = tx.query; const calls: string[] = [];
      tx.query = async (sql, values) => { calls.push(sql); return await query.call(tx, sql, values) as never; };
      let batch;
      try { batch = await resolveEntityRefs(tx, graph, refs); } finally { tx.query = query; }
      expect(batch).toEqual(scalar);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('FOR UPDATE');
      const failure = async (many: boolean, one: typeof refs[number]) => {
        try { if (many) await resolveEntityRefs(tx, graph, [one]); else await resolveEntityRef(tx, graph, one); }
        catch (error) { return (error as Error).message; }
        throw new Error('invalid endpoint accepted');
      };
      expect(await failure(true, ref('missing'))).toBe(await failure(false, ref('missing')));
      await publishGraphDrafts(tx, graph, { vertices: [], removals: [{ ...ref('b'), producer: 'fixture' }] });
      expect(await failure(true, ref('b'))).toBe(await failure(false, ref('b')));
      const binding = requireWriteCapability(tx);
      bindWriteCapability(tx, { ...binding, scope: otherSource });
      expect(await failure(true, ref('a'))).toBe(await failure(false, ref('a')));
      bindWriteCapability(tx, binding);
      const wrongUid = { ...ref('a'), uid: '019a0000-0000-7000-8000-000000000099' };
      expect(await failure(true, wrongUid)).toBe(await failure(false, wrongUid));
      let firstFailure;
      try { await resolveEntityRefs(tx, graph, [ref('missing'), wrongUid]); } catch (error) { firstFailure = (error as Error).message; }
      expect(firstFailure).toBe(await failure(false, ref('missing')));
      for (const uid of [TEST_SOURCE_UID.toUpperCase(), `{${TEST_SOURCE_UID}}`, TEST_SOURCE_UID.replaceAll('-', '')]) {
        const sourceRef = { kind: 'plugin', key: {}, uid };
        expect(await resolveEntityRefs(tx, graph, [sourceRef])).toEqual([await resolveEntityRef(tx, graph, sourceRef)]);
      }
    });
  });
}, 30_000);
