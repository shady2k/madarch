/**
 * A product may declare code.file's lines and no class. The file facts read only the columns the manifest declares; the
 * absent class is unknown, never a query for a column the generated table does not hold.
 */
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { loadAssertions, loadAssertionsBatch } from '../src/graph/assertion-read.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { expect, test } from 'bun:test';
import type { OuterTransaction } from '../src/adapters/database-owner.js';
import { GIT_KINDS } from '../src/fill/stages/git-contract.js';
import { GraphReader, type GeneratedEdgeRead, type GeneratedKindRead } from '../src/knowledge/graph-read.js';

async function withFileReader(
  columns: readonly string[],
  repositoryEdge: boolean,
  check: (held: { reader: GraphReader; queries: string[]; tx: OuterTransaction; fileId: number; otherFileId: number; fileUid: string; otherFileUid: string; repositoryUid: string }) => Promise<void>,
): Promise<void> {
  const file: GeneratedKindRead = { kind: GIT_KINDS.file, table: 'ordinary_file', key: ['repository', 'path'], columns, types: {} };
  const contract: GraphContract = withAssertionContract({
    vertex: [
      { name: GIT_KINDS.repository, table: 'ordinary_repository', capability: 'disk', key: ['name'], fields: [{ name: 'name', type: 'text' }] },
      { name: file.kind, table: file.table, capability: 'disk', key: file.key,
        fields: columns.map(name => ({ name, type: name === 'lines' ? 'integer' : 'text' })) },
    ],
    edge: repositoryEdge ? [{ name: 'fixture.file-repository', capability: 'disk', from: [GIT_KINDS.file], to: [GIT_KINDS.repository], fields: [], repeats: false,
      cardinality: { from: 'one', to: 'many' }, labels: { en: { out: 'repository', in: 'files' }, ru: { out: 'repository', in: 'files' } } }] : [],
    dictionary: [],
  });
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const repository = { kind: GIT_KINDS.repository, key: { name: 'repo' } };
    const target = { kind: file.kind, key: { repository: 'repo', path: 'src/a.ts' } };
    const other = { kind: file.kind, key: { repository: 'repo', path: 'src/other.ts' } };
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, contract, {
        vertices: [
          { ...repository, values: {}, producer: 'fixture', producerVersion: '1' },
          { ...target, values: { lines: 700, ...(columns.includes('class') ? { class: 'generated' } : {}) }, producer: 'fixture', producerVersion: '1' },
          { ...other, values: { lines: 12, ...(columns.includes('class') ? { class: 'handwritten' } : {}) }, producer: 'fixture', producerVersion: '1' },
        ],
        edges: repositoryEdge ? [{ kind: 'fixture.file-repository', from: target, to: repository, values: {}, producer: 'fixture', producerVersion: '1' }] : [],
        removals: [],
      });
    });
    await owner.transaction('snapshot', async tx => {
      const identities = await tx.query<{ id: number; uid: string; path: string; kind: string }>(`SELECT n.id, n.uid::text, n.key->>'path' AS path, k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=ANY($1::text[])`, [[file.kind, GIT_KINDS.repository]]);
      const targetRow = identities.rows.find(row => row.path === 'src/a.ts')!;
      const otherRow = identities.rows.find(row => row.path === 'src/other.ts')!;
      const repositoryRow = identities.rows.find(row => row.kind === GIT_KINDS.repository)!;
      const queries: string[] = [];
      const observed = { ...tx, query: ((...args: Parameters<typeof tx.query>) => {
        queries.push(args[0]);
        return tx.query(...args);
      }) as typeof tx.query };
      const edges = new Map<string, GeneratedEdgeRead>(repositoryEdge ? [['fixture.file-repository', { kind: 'fixture.file-repository', columns: [], types: {}, from: [file.kind], to: [GIT_KINDS.repository] }]] : []);
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, observed, new Set([file.kind]), new Map([[file.kind, file]]), edges, contract);
      await check({ reader, queries, tx: observed,
        fileId: Number(targetRow.id), otherFileId: Number(otherRow.id),
        fileUid: targetRow.uid, otherFileUid: otherRow.uid, repositoryUid: repositoryRow.uid });
    });
  } finally {
    await owner.close();
  }
}

test('a file kind without a class reads its facts and calls the class unknown', async () => {
  await withFileReader(['path', 'repository', 'lines'], true, async held => {
    const facts = await held.reader.fileFacts('src/a.ts', 10);
    expect(facts).toEqual({ total: 1, rows: [{ key: `${GIT_KINDS.file}:repo/src/a.ts`, node: held.fileUid, path: 'src/a.ts', repository: 'repo', scope: held.repositoryUid, class: 'unknown', lines: 700 }] });
    expect(held.queries.join('\n')).not.toContain(assertionValueTableName(GIT_KINDS.file, 'vertex', 'class'));
    expect(held.queries.join('\n')).toContain("'fixture.file-repository'");
  });
});

test('a file kind with no declared repository edge leaves repository and scope empty', async () => {
  await withFileReader(['path', 'repository', 'lines'], false, async held => {
    const facts = await held.reader.fileFacts('src/a.ts', 10);
    expect(facts).toEqual({ total: 1, rows: [{ key: `${GIT_KINDS.file}:repo/src/a.ts`, node: held.fileUid, path: 'src/a.ts', repository: '', scope: '', class: 'unknown', lines: 700 }] });
    expect(held.queries.join('\n')).not.toContain('fixture.file-repository');
  });
});

test('a file kind with a class reads that column', async () => {
  await withFileReader(['path', 'repository', 'lines', 'class'], true, async held => {
    const facts = await held.reader.fileFacts('src/a.ts', 10);
    expect(facts).toEqual({ total: 1, rows: [{ key: `${GIT_KINDS.file}:repo/src/a.ts`, node: held.fileUid, path: 'src/a.ts', repository: 'repo', scope: held.repositoryUid, class: 'generated', lines: 700 }] });
    expect(held.queries.join('\n')).toContain(assertionValueTableName(GIT_KINDS.file, 'vertex', 'class'));
  });
});

test('a different file subject cannot supply the fixture assertions', async () => {
  await withFileReader(['path', 'repository', 'lines', 'class'], true, async held => {
    const values = (rows: Awaited<ReturnType<typeof loadAssertions>>) => rows.map(row => [row.subject, row.property, row.value]);
    const expected = [[{ type: 'vertex', uid: held.fileUid }, 'lines', 700], [{ type: 'vertex', uid: held.fileUid }, 'class', 'generated']];
    const target = await loadAssertions(held.tx, 'vertex', GIT_KINDS.file, ['lines', 'class'], [held.fileId]);
    const wrong = await loadAssertions(held.tx, 'vertex', GIT_KINDS.file, ['lines', 'class'], [held.otherFileId]);
    expect(values(target)).toEqual(expected);
    expect(values(wrong)).toEqual([[{ type: 'vertex', uid: held.otherFileUid }, 'lines', 12], [{ type: 'vertex', uid: held.otherFileUid }, 'class', 'handwritten']]);
    expect(() => expect(values(wrong)).toEqual(expected)).toThrow();
  });
});


test('typed assertion JSON preserves exact sequences without changing internal values', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const raw = {
    request_index: 0, id: 'assertion', subject_id: 1, subject_uid: 'file',
    edge_from: null, edge_to: null, context_id: 1, language: null,
    source: 'source', author: 'author', unit: null, operation_uid: 'operation', evidence: [],
    operation: 'assert', valid_from: at, valid_to: null, recorded_at: at,
    recorded_sequence: '9007199254740993',
  };
  const tx = { query: async () => ({ rows: [
    { ...raw, property: 'lines', value: '700', value_type: 'bigint' },
    { ...raw, property: 'bytes', value: '9007199254740993', value_type: 'bigint' },
    { ...raw, property: 'date', value: '2026-01-01T00:00:00+00:00', value_type: 'timestamp with time zone' },
  ] }) } as unknown as SqlExecutor;
  const stored = await loadAssertions(tx, 'vertex', GIT_KINDS.file, ['lines', 'bytes', 'date']);
  expect(stored.map(row => row.value)).toEqual([700, '9007199254740993', at]);
  for (const row of stored) {
    expect(typeof row.recordedSequence).toBe('bigint');
    expect(row.recordedSequence).toBe(9007199254740993n);
    expect(Object.keys(row)).not.toContain('toJSON');
  }
  const serialized = JSON.parse(JSON.stringify(stored));
  expect(serialized.map((row: { recordedSequence: string }) => row.recordedSequence)).toEqual([
    '9007199254740993', '9007199254740993', '9007199254740993',
  ]);
  expect(serialized.map((row: { value: unknown }) => row.value)).toEqual([700, '9007199254740993', at]);
});

const typedBatchGraph:GraphContract={vertex:[{name:'typed',table:generatedTableName('typed','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'amount',type:'bigint'},{name:'when',type:'timestamp'},{name:'enabled',type:'boolean'},{name:'details',type:'json',schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}}],capability:'fixture'}],edge:[],dictionary:[]};
test('assertion property batch preserves native typed values and subject filtering',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:typedBatchGraph,authenticated:false});
 try{
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,typedBatchGraph);await publishGraphDrafts(tx,typedBatchGraph,{vertices:['one','two'].map(name=>({kind:'typed',key:{name},values:{amount:name==='one'?'9223372036854775807':'9007199254740991',when:'2026-01-01T12:00:00.123Z',enabled:true,details:{count:3}},producer:'fixture',producerVersion:'1'})),removals:[]});});
  await owner.run(async tx=>{
   const identities=await tx.query<{id:number}>(`SELECT id FROM node WHERE key->>'name'='one'`);
   let reads=0;const executor={query:((...args:Parameters<typeof tx.query>)=>{reads++;return tx.query(...args);}) as typeof tx.query};
   const rows=await loadAssertions(executor,'vertex','typed',['amount','when','enabled','details'],[Number(identities.rows[0]!.id)]);
   expect(reads).toBe(1);expect(rows.map(row=>[row.property,row.value])).toEqual([['amount','9223372036854775807'],['when','2026-01-01T12:00:00.123Z'],['enabled',true],['details',{count:3}]]);
   expect(await loadAssertions(executor,'vertex','typed',['amount'],[])).toEqual([]);expect(reads).toBe(1);
   const all=await loadAssertions(executor,'vertex','typed',['amount']);
   expect(all.map(row=>row.value)).toEqual(['9223372036854775807',9007199254740991]);
   const beforeBatch=reads;
   const batches=await loadAssertionsBatch(executor,[
    {sort:'vertex',kind:'typed',properties:['amount'],subjectIds:[Number(identities.rows[0]!.id)]},
    {sort:'vertex',kind:'typed',properties:['enabled','amount']},
    {sort:'vertex',kind:'typed',properties:['details'],subjectIds:[]},
   ]);
   expect(reads-beforeBatch).toBe(1);
   expect(batches.map(batch=>batch.map(row=>[row.property,row.value]))).toEqual([
    [['amount','9223372036854775807']],
    [['enabled',true],['enabled',true],['amount','9223372036854775807'],['amount',9007199254740991]],
    [],
   ]);
  });
 }finally{await owner.close();}
},30000);

test('typed history batches retain retractions, duplicate properties and request boundaries',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:typedBatchGraph,authenticated:false});
 try{
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,typedBatchGraph);
   await publishGraphDrafts(tx,typedBatchGraph,{vertices:[{kind:'typed',key:{name:'history'},values:{amount:'9223372036854775807',enabled:true},producer:'fixture',producerVersion:'1'}],removals:[]});
   const subject=(await tx.query<{id:string}>(`SELECT id::text AS id FROM node WHERE key->>'name'='history'`)).rows[0]!;
   await writeAssertion(tx,typedBatchGraph,{sort:'vertex',kind:'typed',subjectId:subject.id,property:'amount',operation:'retract'});
  });
  await owner.run(async tx=>{
   const requests=[
    {sort:'vertex' as const,kind:'typed',properties:['amount','amount']},
    {sort:'vertex' as const,kind:'typed',properties:['enabled','amount']},
    {sort:'vertex' as const,kind:'typed',properties:['amount'],subjectIds:[]},
   ];
   const batches=await loadAssertionsBatch(tx,requests);
   expect(batches[0]!.map(row=>[row.property,row.operation,row.value])).toEqual([
    ['amount','assert','9223372036854775807'],['amount','assert','9223372036854775807'],['amount','retract',null],
   ]);
   expect(batches[1]!.map(row=>[row.property,row.operation,row.value])).toEqual([
    ['enabled','assert',true],['amount','assert','9223372036854775807'],['amount','retract',null],
   ]);
   expect(batches[2]).toEqual([]);
   for(const [index,request] of requests.entries())expect(batches[index]).toEqual(await loadAssertions(tx,request.sort,request.kind,request.properties,'subjectIds' in request?request.subjectIds:undefined));
  });
 }finally{await owner.close();}
},30000);

