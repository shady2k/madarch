import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { SQL_TRANSACTION_KINDS, type SqlExecutor } from '../src/sql-driver.js';
import type { PluginVertexResult, PluginEdgeResult, PluginEvidence, PluginKeyValues } from '../src/plugin/protocol.js';
import { withSpan } from '../src/obs/trace.js';
import { loadAssertions, type StoredAssertion } from '../src/graph/assertion-read.js';
import { referenceOf, sdkReference } from '../src/graph/plugin-turns.js';

import { sha256Hex } from '../src/graph/digest.js';
import { generatedTableName, type GraphContract, type VertexDraft } from '../src/graph/contract.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { batchPreconditions, reconcileFacts } from '../src/plugin-sdk.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const retained = 'first\nsecond\nthird\nfourth';
const digest = sha256Hex(Buffer.from(retained));
const contract: GraphContract = {
  vertex: [{ name: 'fixture.snapshot', table: generatedTableName('fixture.snapshot', 'vertex'), key: ['digest'], capability: 'reader', fields: [{ name: 'digest', type: 'text' }, { name: 'content', type: 'text' }], evidence: { immutable: true, digestField: 'digest', contentField: 'content', digestAlgorithm: 'sha256' } }, { name: 'fixture.item', table: generatedTableName('fixture.item', 'vertex'), key: ['name'], capability: 'reader', fields: [{ name: 'name', type: 'text' }, { name: 'text', type: 'text', nullable: true }] }],
  edge: [{ name: 'fixture.link', table: generatedTableName('fixture.link', 'edge'), from: ['fixture.item'], to: ['fixture.item'], cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'связан', in: 'связан' } }, repeats: true, discriminator: 'place', capability: 'reader', fields: [{ name: 'text', type: 'text', nullable: true }] }],
  dictionary: [],
};
const evidence = [{ target: { kind: 'fixture.snapshot', key: { digest } }, locator: { path: 'src/items.ts', lineStart: 2, lineEnd: 4 } }];
const otherSource = '019a0000-0000-7000-8000-000000000099';
const item = (name: string, text: string, producer = 'reader'): VertexDraft => ({ kind: 'fixture.item', key: { name }, values: { text }, producer, producerVersion: '1', evidence });
const ref = (name: string) => ({ kind: 'fixture.item', key: { name } });

test('own-fact storage reads only current producer opinions, retaining values and evidence for no-op reconciliation', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const publish = async (vertices: readonly VertexDraft[], source = TEST_SOURCE_UID) => await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, contract, source); return await publishGraphDrafts(tx, contract, { vertices, removals: [] }, 1); });
    await publish([{ kind: 'fixture.snapshot', key: { digest }, values: { content: retained }, producer: 'reader', producerVersion: '1' }]);
    await publish([item('changed', 'old'), item('removed', 'gone')]);
    await publish([item('other-source', 'not ours', 'other')], otherSource);
    await publish([item('changed', 'current'), item('target', 'target')]);
    await owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices: [], removals: [{ kind: 'fixture.item', key: { name: 'removed' }, producer: 'reader', evidence }], edges: [
      { kind: 'fixture.link', from: ref('changed'), to: ref('target'), discriminator: 'line:2', values: { text: 'linked' }, producer: 'reader', producerVersion: '1', evidence },
    ] }, 1));
    const facts = await producerFacts(owner, contract, TEST_SOURCE_UID, ['fixture.item'], ['fixture.link']);
    expect(facts.vertices.map(v => v.key['name']).sort()).toEqual(['changed', 'target']);
    expect(facts.vertices.find(v => v.key['name'] === 'changed')?.values).toEqual({ text: 'current' });
    const expectedEvidence = { target: { kind: 'fixture.snapshot', key: { digest } }, path: 'src/items.ts', lineStart: 2, lineEnd: 4 };
    for (const vertex of facts.vertices) expect(vertex.evidence).toMatchObject(expectedEvidence);
    expect(facts.edges).toMatchObject([{ kind: 'fixture.link', from: ref('changed'), to: ref('target'), discriminator: 'line:2', values: { text: 'linked' }, evidence: expectedEvidence }]);
    expect(reconcileFacts({ ...facts, end: { state: 'complete' } }, facts, {})).toEqual([]);
    const other = await producerFacts(owner, contract, otherSource, ['fixture.item'], ['fixture.link']);
    expect(other.vertices.map(v => v.key['name'])).toEqual(['other-source']);
    expect(other.edges).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);

// Retained verbatim from the pre-batching reader, apart from the local function names.
async function oldEvidenceOf(tx: SqlExecutor, contract: GraphContract, assertions: readonly StoredAssertion[]): Promise<PluginEvidence | undefined> {
  if (assertions.every(assertion => assertion.evidence.length === 0)) return undefined;
  const links = await withSpan('graph.producer-facts.evidence', {}, async () => await tx.query<{ id: number; kind: string; discriminator: string }>(
    `SELECT target.id,k.name AS kind,e.discriminator FROM edge e JOIN entity ek ON ek.id=e.entity_id
     JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node JOIN entity k ON k.id=target.entity_id
     WHERE ek.name='system.assertion-evidence' AND origin.uid=ANY($1::uuid[]) ORDER BY origin.uid,e.discriminator,e.uid LIMIT 1`, [assertions.map(assertion => assertion.id)]));
  const link = links.rows[0];
  if (link === undefined) return undefined;
  const target = await referenceOf(tx, contract, link.kind, Number(link.id));
  const { locator } = JSON.parse(link.discriminator) as { locator: Record<string, unknown> };
  return { target: sdkReference(target), ...(typeof locator['path'] === 'string' ? { path: locator['path'] } : {}),
    ...(typeof locator['commit'] === 'string' ? { commit: locator['commit'] } : {}),
    ...(typeof locator.digest === 'string' ? { digest: locator.digest } : {}),
    ...(typeof locator['lineStart'] === 'number' ? { lineStart: locator['lineStart'] } : {}),
    ...(typeof locator['lineEnd'] === 'number' ? { lineEnd: locator['lineEnd'] } : {}) };
}

/** The argument is the host-issued source uid, never a producer display name. */
async function oldProducerFacts(owner: DatabaseOwner, contract: GraphContract, sourceUid: string, kinds: readonly string[], edgeKinds: readonly string[]): Promise<{ vertices: PluginVertexResult[]; edges: PluginEdgeResult[] }> {
  return await withSpan('graph.producer-facts', { sourceUid }, async () => await owner.transaction(SQL_TRANSACTION_KINDS.snapshot, async tx => {
    const now = new Date((await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now).toISOString();
    const selector = { validAt: now, recordedAt: now, contexts: [1] };
    const vertices: PluginVertexResult[] = [];
    const edges: PluginEdgeResult[] = [];
    for (const sort of ['vertex', 'edge'] as const) for (const name of sort === 'vertex' ? kinds : edgeKinds) {
      const kind = contract[sort].find(declaration => declaration.name === name);
      if (kind === undefined) throw new Error(`${import.meta.path}:39: unknown reconciliation ${sort} kind ${name}`);
      const identities = await tx.query<{ id: number; from_node?: number; to_node?: number; discriminator?: string }>(
        sort === 'vertex' ? 'SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 ORDER BY n.uid'
          : 'SELECT n.id,n.from_node,n.to_node,n.discriminator FROM edge n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 ORDER BY n.uid', [name]);
      const fields = kind.fields.filter(field => sort === 'edge' || !('key' in kind && kind.key.includes(field.name))).map(field => field.name);
      const assertions = (await loadAssertions(tx, sort, name, ['$exists', ...fields], identities.rows.map(row => Number(row.id)), { ...selector, sourceUids: [sourceUid] })).filter(assertion => assertion.source === sourceUid && assertion.language === null);
      const selected = new Set(assertions.filter(assertion => assertion.selected).map(assertion => assertion.id));
      for (const row of identities.rows) {
        const own = assertions.filter(assertion => assertion.subjectId === Number(row.id) && selected.has(assertion.id));
        if (!own.some(assertion => assertion.property === '$exists' && assertion.value === true)) continue;
        const values = Object.fromEntries(own.filter(assertion => assertion.property !== '$exists').map(assertion => [assertion.property, assertion.value]));
        const evidence = await oldEvidenceOf(tx, contract, own);
        if (sort === 'vertex') {
          const ref = sdkReference(await referenceOf(tx, contract, name, Number(row.id), new Set(), selector));
          vertices.push({ kind: name, key: ref.key, ...(ref.keyEdges === undefined ? {} : { keyEdges: ref.keyEdges }), values, ...(evidence === undefined ? {} : { evidence }) });
        } else {
          const ends = (await tx.query<{ id: number; kind: string }>('SELECT n.id,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[])', [[row.from_node!, row.to_node!]])).rows;
          const fromKind = ends.find(end => Number(end.id) === Number(row.from_node))?.kind;
          const toKind = ends.find(end => Number(end.id) === Number(row.to_node))?.kind;
          if (fromKind === undefined || toKind === undefined) throw new Error(`${import.meta.path}:61: reconciliation edge has a missing endpoint`);
          edges.push({ kind: name, from: sdkReference(await referenceOf(tx, contract, fromKind, Number(row.from_node), new Set(), selector)), to: sdkReference(await referenceOf(tx, contract, toKind, Number(row.to_node), new Set(), selector)),
            ...(row.discriminator === '' ? {} : { discriminator: row.discriminator }), values, ...(evidence === undefined ? {} : { evidence }) });
        }
      }
    }
    return { vertices, edges };
  }));
}

const partitionContract: GraphContract = {
  vertex: [
    ...contract.vertex.filter(vertex => vertex.name === 'fixture.snapshot'),
    { name: 'code.repository', table: 'unused', key: ['name'], capability: 'reader', fields: [{ name: 'name', type: 'text' }] },
    { name: 'code.file', table: 'unused', key: ['path'], capability: 'reader', fields: [{ name: 'path', type: 'text' }, { name: 'text', type: 'text', nullable: true }], keyEdges: [{ role: 'repository', edge: 'code.file-repository', direction: 'from', onDelete: 'restrict' }] },
  ],
  edge: [
    { ...contract.edge[0]!, name: 'code.file-repository', from: ['code.file'], to: ['code.repository'], repeats: false, discriminator: undefined, cardinality: { from: 'many', to: 'one' }, fields: [] },
    { ...contract.edge[0]!, name: 'code.file-link', from: ['code.file'], to: ['code.file'] },
    { ...contract.edge[0]!, name: 'fixture.snapshot-about', from: ['fixture.snapshot'], to: ['code.file'], repeats: false, discriminator: undefined, fields: [] },
  ],
  dictionary: [],
};
const repository = { kind: 'code.repository', key: { name: 'fixture' } };
const fileRef = (path: string) => ({ kind: 'code.file', key: { path }, keyEdges: { repository } });
const fileEvidence = (path: string) => [{ target: { kind: 'fixture.snapshot', key: { digest } }, locator: { path, commit: 'fixture-commit', digest, lineStart: 2, lineEnd: 4 } }];

async function publishFiles(owner: DatabaseOwner, paths: readonly string[]): Promise<void> {
  await owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, partitionContract);
    await publishGraphDrafts(tx, partitionContract, {
      vertices: [
        { kind: 'fixture.snapshot', key: { digest }, values: { content: retained }, producer: 'reader', producerVersion: '1' },
        { ...repository, values: {}, producer: 'reader', producerVersion: '1' },
        ...paths.map(path => ({ ...fileRef(path), values: { text: `contents of ${path}` }, producer: 'reader', producerVersion: '1', evidence: fileEvidence(path) })),
      ],
      edges: paths.map(path => ({ kind: 'code.file-repository', from: fileRef(path), to: repository, producer: 'reader', producerVersion: '1', evidence: fileEvidence(path) })),
      removals: [],
    }, 1);
  });
}

function recordingOwner(owner: DatabaseOwner): { owner: DatabaseOwner; queries: string[] } {
  const queries: string[] = [];
  const transaction: DatabaseOwner['transaction'] = (kind, work) => owner.transaction(kind, tx => {
    const query: SqlExecutor['query'] = (sql, values) => { queries.push(sql); return tx.query(sql, values); };
    return work(new Proxy(tx, { get: (target, property, receiver) => property === 'query' ? query : Reflect.get(target, property, receiver) }));
  });
  return { owner: new Proxy(owner, { get: (target, property, receiver) => property === 'transaction' ? transaction : Reflect.get(target, property, receiver) }), queries };
}

test('producer fact queries stay constant and at most fifteen for ten and two hundred own code.file rows', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: partitionContract });
  try {
    const paths = Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`);
    const started = performance.now();
    await publishFiles(owner, paths.slice(0, 10));
    console.log('producerFacts form fixture ten published ms', performance.now() - started);
    const small = recordingOwner(owner);
    expect((await producerFacts(small.owner, partitionContract, TEST_SOURCE_UID, ['code.file'], [])).vertices).toHaveLength(10);
    console.log('producerFacts query count ten', small.queries.length);
    expect(small.queries.length).toBeLessThanOrEqual(15);
    await publishFiles(owner, paths.slice(10));
    console.log('producerFacts form fixture two hundred published ms', performance.now() - started);
    const large = recordingOwner(owner);
    expect((await producerFacts(large.owner, partitionContract, TEST_SOURCE_UID, ['code.file'], [])).vertices).toHaveLength(200);
    console.log('producerFacts query counts', JSON.stringify({ small: small.queries.length, large: large.queries.length }));
    expect(large.queries.length).toBe(small.queries.length);
    expect(large.queries.length).toBeLessThanOrEqual(15);
  } finally { await owner.close(); }
}, 30_000);

test('batched producer facts are byte-identical to the old reader for key edges, evidence and both edge endpoints', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: partitionContract });
  try {
    await publishFiles(owner, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, partitionContract);
      await publishGraphDrafts(tx, partitionContract, { vertices: [], removals: [], edges: [
        { kind: 'code.file-link', from: fileRef('src/a.ts'), to: fileRef('src/b.ts'), discriminator: 'line:2', values: { text: 'first link' }, producer: 'reader', producerVersion: '1', evidence: fileEvidence('src/a.ts') },
        { kind: 'code.file-link', from: fileRef('src/b.ts'), to: fileRef('src/c.ts'), discriminator: 'line:4', values: { text: null }, producer: 'reader', producerVersion: '1', evidence: fileEvidence('src/b.ts') },
      ] }, 1);
    });
    const expected = await oldProducerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], ['code.file-link', 'code.file-repository']);
    expect(expected.vertices).toHaveLength(3);
    expect(expected.edges).toHaveLength(5);
    expect(expected.vertices.every(vertex => vertex.keyEdges?.repository?.kind === 'code.repository' && vertex.evidence?.commit === 'fixture-commit')).toBe(true);
    const actual = await producerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], ['code.file-link', 'code.file-repository']);
    const { revisions: _revisions, coverage: _coverage, ...held } = actual;
    expect(JSON.stringify(held)).toBe(JSON.stringify(expected));
  } finally { await owner.close(); }
}, 30_000);

test('own facts name every covered subject\u2019s stream position, a retracted subject and its key edge included', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: partitionContract });
  try {
    await publishFiles(owner, ['src/a.ts', 'src/b.ts']);
    const before = await producerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], []);
    const vertexSubjects = before.revisions.filter(revision => revision.subject.sort === 'vertex');
    expect(vertexSubjects.map(revision => revision.subject.sort === 'vertex' ? revision.subject.key['path'] : undefined).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(vertexSubjects.every(revision => revision.subject.sort === 'vertex' && revision.subject.keyEdges?.['repository']?.kind === 'code.repository' && /^[0-9]+$/u.test(revision.recordedSequence))).toBe(true);
    const sequenceOf = (path: string): string => before.revisions.find(revision => revision.subject.sort === 'vertex' && revision.subject.key['path'] === path)!.recordedSequence;
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, partitionContract);
      await publishGraphDrafts(tx, partitionContract, { vertices: [], removals: [{ ...fileRef('src/b.ts'), producer: 'reader' }] }, 1);
    });
    const after = await producerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], []);
    expect(after.vertices.map(vertex => vertex.key['path'])).toEqual(['src/a.ts']);
    // A withdrawn subject stays in the stream: its key edge was retracted with it, so the parent role is read from the
    // rows the graph holds, never from an active assertion.
    const withdrawn = after.revisions.find(revision => revision.subject.sort === 'vertex' && revision.subject.key['path'] === 'src/b.ts');
    expect(withdrawn).toBeDefined();
    expect(withdrawn!.subject).toEqual({ sort: 'vertex', kind: 'code.file', key: { path: 'src/b.ts' }, keyEdges: { repository: { kind: 'code.repository', key: { name: 'fixture' } } } });
    expect(BigInt(withdrawn!.recordedSequence) > BigInt(sequenceOf('src/b.ts'))).toBe(true);
    expect(sequenceOf('src/a.ts')).toBe(after.revisions.find(revision => revision.subject.sort === 'vertex' && revision.subject.key['path'] === 'src/a.ts')!.recordedSequence);
    // A subject this source never asserted is named by no revision at all: a batch states that absence itself.
    expect(after.revisions.some(revision => revision.subject.sort === 'vertex' && revision.subject.key['path'] === 'src/never.ts')).toBe(false);
  } finally { await owner.close(); }
}, 30_000);

test('producer fact scope selects only owned endpoint triples, including a read-only owner', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: partitionContract });
  try {
    await publishFiles(owner, ['src/a.ts']);
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, partitionContract);
      await publishGraphDrafts(tx, partitionContract, { vertices: [], removals: [], edges: [
        { kind: 'fixture.snapshot-about', from: { kind: 'fixture.snapshot', key: { digest } }, to: fileRef('src/a.ts'), producer: 'reader', producerVersion: '1' },
      ] }, 1);
    });
    const scopedProducerFacts = producerFacts as (owner: DatabaseOwner, contract: GraphContract, sourceUid: string, kinds: readonly string[], edgeKinds: readonly string[], scope: { readonly kind: string; readonly ownedEdges?: readonly { kind: string; from: string; to: string }[] }) => ReturnType<typeof producerFacts>;
    const supportEdges = ['fixture.snapshot-about'];
    const ownedEdges = [{ kind: 'fixture.snapshot-about', from: 'fixture.snapshot', to: 'code.file' }];
    const unscoped = await producerFacts(owner, partitionContract, TEST_SOURCE_UID, [], supportEdges);
    expect(unscoped.edges).toHaveLength(1);
    expect(unscoped.edges[0]).toMatchObject({ from: { kind: 'fixture.snapshot', key: { digest } }, to: fileRef('src/a.ts') });
    const sourceScope = await scopedProducerFacts(owner, partitionContract, TEST_SOURCE_UID, ['fixture.snapshot'], supportEdges, { kind: 'code.gitlink', ownedEdges: [] });
    expect(sourceScope.vertices).toEqual([]);
    expect(sourceScope.edges).toEqual([]);
    const targetScope = await scopedProducerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], supportEdges, { kind: 'code.file', ownedEdges });
    expect(targetScope.edges).toEqual(unscoped.edges);
    const reader = await scopedProducerFacts(owner, partitionContract, TEST_SOURCE_UID, [], supportEdges, { kind: 'reader.index', ownedEdges });
    expect(reader.edges).toEqual(unscoped.edges);
    const neitherEndpoint = await producerFacts(owner, partitionContract, TEST_SOURCE_UID, ['fixture.snapshot'], ['code.file-repository'], { kind: 'fixture.snapshot' });
    expect(neitherEndpoint.edges).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);

test('producer facts filter partition keys and evidence paths before returning own facts and edges', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: partitionContract });
  try {
    await publishFiles(owner, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const scopedProducerFacts = producerFacts as (owner: DatabaseOwner, contract: GraphContract, sourceUid: string, kinds: readonly string[], edgeKinds: readonly string[], scope: { readonly kind: string; readonly keys?: readonly PluginKeyValues[]; readonly paths?: readonly string[]; readonly ownedEdges?: readonly { kind: string; from: string; to: string }[] }) => ReturnType<typeof producerFacts>;
    const keys = await scopedProducerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], ['code.file-repository'], { kind: 'code.file', ownedEdges: [{ kind: 'code.file-repository', from: 'code.file', to: 'code.repository' }], keys: [{ path: 'src/b.ts' }] });
    expect(keys.vertices.map(vertex => vertex.key)).toEqual([{ path: 'src/b.ts' }]);
    expect(keys.edges.map(edge => edge.from.key)).toEqual([{ path: 'src/b.ts' }]);
    const paths = await scopedProducerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], ['code.file-repository'], { kind: 'code.file', ownedEdges: [{ kind: 'code.file-repository', from: 'code.file', to: 'code.repository' }], paths: ['src/c.ts'] });
    expect(paths.vertices.map(vertex => vertex.key)).toEqual([{ path: 'src/c.ts' }]);
    expect(paths.edges.map(edge => edge.from.key)).toEqual([{ path: 'src/c.ts' }]);
    const empty = await scopedProducerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], ['code.file-repository'], { kind: 'code.file', ownedEdges: [{ kind: 'code.file-repository', from: 'code.file', to: 'code.repository' }], keys: [] });
    expect(empty).toEqual({ vertices: [], edges: [], revisions: [], coverage: { vertices: { kind: 'code.file', keys: [] }, edges: ['code.file-repository'] } });
  } finally { await owner.close(); }
}, 30_000);

test('a read of one partition names the position of an own-kind support it resolved', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: partitionContract });
  try {
    // src/a.ts stands in the neighbouring partition; the link from this partition's key makes the read resolve it.
    await publishFiles(owner, ['src/a.ts', 'src/b.ts']);
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, partitionContract);
      await publishGraphDrafts(tx, partitionContract, { vertices: [], removals: [], edges: [
        { kind: 'code.file-link', from: fileRef('src/b.ts'), to: fileRef('src/a.ts'), discriminator: 'line:2', producer: 'reader', producerVersion: '1' },
      ] }, 1);
    });
    const scope = { kind: 'code.file', ownedEdges: [{ kind: 'code.file-link', from: 'code.file', to: 'code.file' }], keys: [{ path: 'src/b.ts' }], supportKeys: true };
    const read = await producerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], ['code.file-link'], scope);
    expect(read.vertices.map(vertex => vertex.key['path']).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const positions = read.revisions.flatMap(revision => revision.subject.sort === 'vertex' ? [[String(revision.subject.key['path']), revision.recordedSequence] as const] : []);
    expect(positions.map(([path]) => path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    // A batch that touches the support carries the sequence the stream holds, never a claim that it was never asserted.
    expect(batchPreconditions({ vertices: [fileRef('src/a.ts')] }, 'code.file', read)).toEqual([
      { subject: { sort: 'vertex', kind: 'code.file', key: { path: 'src/a.ts' }, keyEdges: { repository } }, recordedSequence: positions.find(([path]) => path === 'src/a.ts')![1] },
    ]);
  } finally { await owner.close(); }
}, 30_000);

test('a reconciliation answer states the subjects it covered, and a batch claims nothing about one it did not', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: partitionContract });
  try {
    // The neighbouring partition asserted src/a.ts; this partition's own key stands in no assertion of its own yet.
    await publishFiles(owner, ['src/a.ts']);
    const scope = { kind: 'code.file', ownedEdges: [{ kind: 'code.file-link', from: 'code.file', to: 'code.file' }], keys: [{ path: 'src/b.ts' }], supportKeys: true };
    const before = await producerFacts(owner, partitionContract, TEST_SOURCE_UID, ['code.file'], ['code.file-link'], scope);
    expect(before.vertices).toEqual([]);
    expect(before.revisions).toEqual([]);
    expect(before.coverage).toEqual({ vertices: { kind: 'code.file', keys: [{ path: 'src/b.ts' }] }, edges: ['code.file-link'] });
    // The batch this read decides adds the partition's key, the neighbouring support and the link between them. src/a.ts
    // already stands in the other partition's stream, so the batch must claim nothing about it: the read did not cover it.
    const conditions = batchPreconditions({
      vertices: [{ ...fileRef('src/b.ts'), values: { text: 'contents of src/b.ts' } }, fileRef('src/a.ts')],
      edges: [{ kind: 'code.file-link', from: fileRef('src/b.ts'), to: fileRef('src/a.ts'), discriminator: 'line:2' }],
    }, 'code.file', before);
    expect(conditions).toEqual([
      { subject: { sort: 'edge', kind: 'code.file-link', from: fileRef('src/b.ts'), to: fileRef('src/a.ts'), discriminator: 'line:2' } },
      { subject: { sort: 'vertex', kind: 'code.file', key: { path: 'src/b.ts' }, keyEdges: { repository } } },
    ]);
  } finally { await owner.close(); }
}, 30_000);

test('a path-limited read names the position of every subject it returns, the path in its evidence', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, {
        vertices: [
          { kind: 'fixture.snapshot', key: { digest }, values: { content: retained }, producer: 'reader', producerVersion: '1' },
          item('inside', 'selected'),
          { ...item('outside', 'elsewhere'), evidence: [{ target: { kind: 'fixture.snapshot', key: { digest } }, locator: { path: 'elsewhere/items.ts', lineStart: 2, lineEnd: 4 } }] },
        ], removals: [] }, 1);
    });
    const read = await producerFacts(owner, contract, TEST_SOURCE_UID, ['fixture.item'], [], { kind: 'fixture.item', paths: ['src'] });
    expect(read.vertices.map(vertex => vertex.key['name'])).toEqual(['inside']);
    // The subject the answer returns carries the position the stream holds, read from the path its evidence names.
    expect(read.revisions.map(revision => revision.subject.sort === 'vertex' ? revision.subject.key['name'] : '')).toEqual(['inside']);
    // A path-limited read cannot enumerate the keys it covered, so it vouches for no absent subject.
    expect(read.coverage).toEqual({ vertices: { kind: 'fixture.item', keys: [] }, edges: [] });
  } finally { await owner.close(); }
}, 30_000);
