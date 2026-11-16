import { expect, test } from 'bun:test';
import { pluginInvocationAccess } from '../src/plugin/fill-access.js';
import { PluginAgentBridge } from '../src/plugin/agent.js';
import { createTestDatabaseOwner } from './test-database.js';
import { publishGraphDrafts, bindWriteCapability } from '../src/graph/write.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { trackedPluginAnswerer, pluginGraphAnswerer } from '../src/fill/plugin-turns.js';

function setup(output: string, reads: string[], fields = ['text']) {
  const calls: string[] = [];
  const access = pluginInvocationAccess({
    files: async () => { calls.push('files'); return []; },
    value: async (kind) => { calls.push(kind); return kind; },
  }, { location: '/product/plugin.json:7', plugin: 'multi', output, reads, fields, fileKind: 'File', edges: [] });
  return { access, calls };
}

test('multi-output A from X and B from Y have independent API input boundaries', async () => {
  const a = setup('A', ['X']);
  const b = setup('B', ['Y']);
  expect(await a.access.graph.value('X', {}, 'text')).toBe('X');
  expect(await b.access.graph.value('Y', {}, 'text')).toBe('Y');
  await expect(a.access.graph.value('Y', {}, 'text')).rejects.toThrow('/product/plugin.json:7: plugin multi output A');
  expect(a.calls).toEqual(['X']);
  expect(() => a.access.assertAllowed()).toThrow('undeclared catalogue read');
});

test('selecting Files rejects Summary emissions rather than discarding them', () => {
  const { access } = setup('Files', []);
  expect(() => access.assertWrites({ vertices: [{ kind: 'Summary', key: { id: 'a' }, values: { text: 'hidden' } }], edges: [], removals: [] })).toThrow('write of unselected output Summary');
});

test('selected output field and edge boundaries are enforced', () => {
  const { access } = setup('A', ['X']);
  expect(() => access.assertWrites({ vertices: [{ kind: 'A', key: { id: 'a' }, values: { secret: 'hidden' } }], edges: [], removals: [] })).toThrow('A.secret');
  expect(() => setup('A', []).access.assertWrites({ vertices: [], edges: [{ kind: 'hidden', from: { kind: 'A', key: {} }, to: { kind: 'A', key: {} } }], removals: [] })).toThrow('unselected edge');
});

test('a selected support closure admits only its fields and never removes support identities', () => {
  const scoped = () => pluginInvocationAccess({ files: async () => [], value: async () => null }, {
    location: '/product/plugin.json:7', plugin: 'multi', output: 'A', reads: [], fields: ['text'], fileKind: 'File',
    edges: ['support-about'], supportOutputs: new Map([['Support', ['content']]]),
  });
  expect(() => scoped().assertWrites({ vertices: [{ kind: 'Support', key: { digest: 'sha' }, values: { content: 'source' } }], edges: [{ kind: 'support-about', from: { kind: 'Support', key: { digest: 'sha' } }, to: { kind: 'File', key: { path: 'source.ts' } } }] })).not.toThrow();
  expect(() => scoped().assertWrites({ vertices: [{ kind: 'Support', key: { digest: 'sha' } }] })).not.toThrow();
  expect(() => scoped().assertWrites({ vertices: [{ kind: 'OtherSupport', key: {}, values: {} }] })).toThrow('unselected output');
  expect(() => scoped().assertWrites({ vertices: [{ kind: 'Support', key: { digest: 'sha' }, values: { private: 'hidden' } }] })).toThrow('Support.private');
  expect(() => scoped().assertWrites({ removals: [{ kind: 'Support', key: { digest: 'sha' } }] })).toThrow('cannot be removed');
});

test('consistency record reads preserve bounded pages without requiring catalogue content inputs', async () => {
  const calls: unknown[] = [];
  const query = { after: 'cursor', limit: 1 };
  const access = pluginInvocationAccess({
    files: async () => [], value: async () => null,
    removedEnds: async (page) => { calls.push(['removedEnds', page]); return { edges: [], next: 'edges-next' }; },
    unevidenced: async (page) => { calls.push(['unevidenced', page]); return { assertions: [], next: 'assertions-next' }; },
  }, { location: '/product/plugin.json:7', plugin: 'consistency', output: 'Finding', reads: [], fields: [], fileKind: 'File', edges: [] });
  expect(await access.graph.removedEnds!(query)).toEqual({ edges: [], next: 'edges-next' });
  expect(await access.graph.unevidenced!(query)).toEqual({ assertions: [], next: 'assertions-next' });
  expect(calls).toEqual([['removedEnds', query], ['unevidenced', query]]);
  expect(() => access.assertAllowed()).not.toThrow();
});

test('catalogue:true does not let a scripted agent read undeclared files', async () => {
  const { access, calls } = setup('A', ['X']);
  let connected = false;
  const bridge = new PluginAgentBridge({ prompt: 'extract', roots: ['repo'], catalogue: true }, {
    adapter: { id: 'scripted', command: 'never-started' },
    connect: async () => { connected = true; throw new Error('must not start'); },
  }, access.graph, { vertices: [], edges: [] });
  await expect(bridge.run('multi:A', {})).rejects.toThrow('undeclared catalogue read of File');
  expect(connected).toBe(false);
  expect(calls).toEqual([]);
});

test('explicit earlier read freezes producer generation and never reads later replacement', async () => {
  const saved = [{ kind: 'Source', key: { id: 'x' }, values: { text: 'original' } }];
  const savedValue = (kind: string, key: Readonly<Record<string, unknown>>, field: string): unknown => {
    const vertex = saved.find(vertex => vertex.kind === kind && vertex.key.id === key.id);
    return (vertex?.values as Readonly<Record<string, unknown>> | undefined)?.[field] ?? null;
  };
  let seen: unknown;
  const snapshot = { unitUid: 'source-unit', validAt: '2026-01-01T00:00:00Z', recordedAt: '2026-01-01T00:00:00Z' };
  const access = pluginInvocationAccess({ files: async () => [], value: async (kind, key, field, _keyEdges, token) => {
    seen = token;
    return savedValue(kind, key, field);
  } }, { location: '/product/plugin.json:7', plugin: 'summary', output: 'Summary', fields: ['text'], reads: [{ kind: 'Source', version: 'earlier', producer: 'base' }], snapshots: new Map([['Source', snapshot]]), fileKind: 'File', edges: [] });
  expect(await access.graph.value('Source', { id: 'x' }, 'text')).toBe('original');
  expect(seen).toEqual(snapshot);
  expect(savedValue('Source', { id: 'missing' }, 'text')).toBeNull();
  expect(savedValue('Source', { id: 'x' }, 'omitted')).toBeNull();
});

test('earlier file enumeration forwards the exact named snapshot and refuses missing snapshots', async () => {
  const snapshot = { unitUid: 'file-unit', validAt: '2026-01-01T00:00:00Z', recordedAt: '2026-01-01T00:00:00Z' };
  const calls: unknown[] = [];
  const graph = { files: async (pattern: string, token?: typeof snapshot) => { calls.push([pattern, token]); return [{ kind: 'File', key: { path: 'saved.ts' } }]; }, value: async () => null };
  const scope = { location: '/product/plugin.json:7', plugin: 'refiner', output: 'File', fields: [], reads: [{ kind: 'File', version: 'earlier' as const, producer: 'base' }], fileKind: 'File', edges: [] };
  const access = pluginInvocationAccess(graph, { ...scope, snapshots: new Map([['File', snapshot]]) });
  expect(await access.graph.files('**/*.ts')).toEqual([{ kind: 'File', key: { path: 'saved.ts' } }]);
  expect(calls).toEqual([['**/*.ts', snapshot]]);
  await expect(pluginInvocationAccess(graph, scope).graph.files('**')).rejects.toThrow('earlier snapshot of File from base is unavailable');
  expect(calls).toHaveLength(1);
});

test('tracked optional graph arguments remain absent rather than becoming JSON null', async () => {
  const requests: { method: string; args: unknown[] }[] = [];
  const graph = trackedPluginAnswerer({ query: async (text) => { requests.push(JSON.parse(text)); return [[]]; } });
  await graph.files('**', undefined);
  await graph.value('File', { path: 'a' }, 'text', undefined);
  const snapshot = { unitUid: 'saved-unit', validAt: '2026-01-01T00:00:00Z', recordedAt: '2026-01-01T00:00:00Z' };
  await graph.files('**', snapshot);
  expect(requests.map(({ method, args }) => ({ method, args }))).toEqual([
    { method: 'files', args: ['**'] },
    { method: 'value', args: ['File', { path: 'a' }, 'text'] },
    { method: 'files', args: ['**', snapshot] },
  ]);
});

const snapshotUnit = '019a0000-0000-7000-8000-000000000077';
const snapshotRun = '019a0000-0000-7000-8000-000000000078';
async function snapshotFixture() {
  const { parseKinds } = await import('../src/product/manifest/kinds.js');
  const manifest = parseKinds({root:{kinds:{
    'code.repository':{source:'graph',key:['name'],fields:[{name:'name',type:'text',producers:['fixture']}]},
    'code.file':{source:'graph',key:['path'],'key-edges':[{role:'repository',edge:'belongs',side:'from'}],fields:[{name:'path',type:'text',producers:['fixture']},{name:'content',type:'text',producers:['fixture']},{name:'language',type:'text',producers:['fixture']}]},
  },edges:[{name:'belongs',from:['code.file'],to:['code.repository'],'on-parent-delete':'restrict',cardinality:{from:{min:1,max:1},to:{min:0,max:null}},labels:{en:{out:'belongs to',in:'contains'},ru:{out:'принадлежит',in:'содержит'}}}]},at:()=>1},'/fixture/catalog.yaml','/fixture');
  expect(manifest.findings).toEqual([]);
  const contract = withManifestContract(graphContractOf(manifest));
  const owner = await createTestDatabaseOwner({graphContract:contract});
  const encode = (value:unknown):unknown => value instanceof Map ? {$map:[...value].map(([key,value])=>[key,encode(value)])} : Array.isArray(value) ? value.map(encode) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,value])=>[key,encode(value)])) : value;
  const publish = async (vertices:Parameters<typeof publishGraphDrafts>[2]['vertices'],withUnit=false) => owner.transaction('write',async tx=>{
    if(withUnit){
      const binding = await bindTestWriteCapability(tx, contract);
      bindWriteCapability(tx, { ...binding, unitUid: snapshotUnit });
    }
    return await publishGraphDrafts(tx,contract,{vertices,removals:[]});
  });
  await publish([{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify(encode(manifest))},producer:'fixture',producerVersion:'1'},
    {kind:'system.run',uid:snapshotRun,key:{},values:{run_name:'original-run'},producer:'fixture',producerVersion:'1'},
    {kind:'system.unit',uid:snapshotUnit,key:{},values:{unit_name:'plugin-turns/base:Source',generation:3,state:'completed',scope:'base:Source'},producer:'fixture',producerVersion:'1'},
    {kind:'code.repository',key:{name:'repo'},producer:'fixture',producerVersion:'1'}]);
  await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[],edges:[{kind:'system.unit-run',from:{kind:'system.unit',uid:snapshotUnit,key:{}},to:{kind:'system.run',uid:snapshotRun,key:{}},producer:'fixture',producerVersion:'1'}],removals:[]}));
  return {owner,manifest,contract,publish};
}

test('one reader indexes immutable graph snapshot files and fields once without sharing with another reader', async () => {
  const fixture = await snapshotFixture();
  const {owner,publish,...wiring}=fixture;
  const key={path:'a.ts'};
  const keyEdges={repository:{kind:'code.repository',key:{name:'repo'}}};
  const vertex={kind:'code.file',key,keyEdges,values:{content:'saved',language:'typescript'},producer:'fixture',producerVersion:'1'};
  try {
    await publish([vertex],true);
    const now=await owner.transaction('snapshot',async tx=>(await tx.query<{now:string}>('SELECT transaction_timestamp()::text AS now')).rows[0]!.now);
    const snapshot={unitUid:snapshotUnit,recordedAt:now,validAt:now};
    await publish([{...vertex,values:{content:'later',language:'changed'}}],true);
    let loads=0;
    const counted={transaction:async (...args:Parameters<typeof owner.transaction>)=>{loads++;return await owner.transaction(...args);}} as typeof owner;
    const reader=pluginGraphAnswerer({...wiring,owner:counted});
    const files=await reader.files('**/*.ts',snapshot);
    expect(files).toHaveLength(1);
    expect(files[0]?.key).toEqual(key);
    expect(files[0]?.keyEdges?.repository).toMatchObject(keyEdges.repository);
    const frozenKeyEdges=files[0]!.keyEdges!;
    expect(await reader.value('code.file',key,'content',frozenKeyEdges,snapshot)).toBe('saved');
    expect(await reader.value('code.file',key,'language',frozenKeyEdges,snapshot)).toBe('typescript');
    expect(await reader.value('code.file',key,'omitted',frozenKeyEdges,snapshot)).toBeNull();
    expect(loads).toBe(1);
    expect(await pluginGraphAnswerer({...wiring,owner:counted}).value('code.file',key,'content',frozenKeyEdges,snapshot)).toBe('saved');
    expect(loads).toBe(2);
  } finally {await owner.close();}
},30_000);

test('snapshot resolver rejects prior-run or unsuccessful graph units before execution', async () => {
  const {successfulPluginSnapshot}=await import('../src/graph/plugin-turns.js');
  const {owner,publish}=await snapshotFixture();
  try {
    await expect(successfulPluginSnapshot(owner,'run-current','base:Source')).rejects.toThrow('expected one graph run run-current, found 0');
    await publish([{kind:'system.unit',key:{},uid:snapshotUnit,values:{state:'failed'},producer:'fixture',producerVersion:'1'}]);
    await expect(successfulPluginSnapshot(owner,'original-run','base:Source')).rejects.toThrow('expected one completed graph unit');
  } finally {await owner.close();}
},30_000);

test('completed snapshot captures graph unit identity and clock rather than cloning publication', async () => {
  const {successfulPluginSnapshot}=await import('../src/graph/plugin-turns.js');
  const {owner}=await snapshotFixture();
  try {
    const before=await owner.transaction('snapshot',async tx=>(await tx.query<{count:number}>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count);
    const snapshot=await successfulPluginSnapshot(owner,'original-run','base:Source');
    expect(snapshot.unitUid).toBe(snapshotUnit);
    expect(Number.isFinite(Date.parse(snapshot.recordedAt))).toBe(true);
    expect(snapshot.validAt).toBe(snapshot.recordedAt);
    expect(await owner.transaction('snapshot',async tx=>(await tx.query<{count:number}>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count)).toBe(before);
  } finally {await owner.close();}
},30_000);


test('an inherited run resolves only its declared completed unit membership', async()=>{
  const {successfulPluginSnapshot}=await import('../src/graph/plugin-turns.js');
  const {owner,contract,publish}=await snapshotFixture();
  const inheritedRun='019a0000-0000-7000-8000-000000000079';
  try{
    await publish([{kind:'system.run',uid:inheritedRun,key:{},values:{run_name:'inherited-run'},producer:'fixture',producerVersion:'1'}]);
    await expect(successfulPluginSnapshot(owner,'inherited-run','base:Source')).rejects.toThrow('expected one completed graph unit');
    await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[],edges:[{kind:'system.run-inherited-unit',from:{kind:'system.run',uid:inheritedRun,key:{}},to:{kind:'system.unit',uid:snapshotUnit,key:{}},producer:'fixture',producerVersion:'1'}],removals:[]}));
    expect((await successfulPluginSnapshot(owner,'inherited-run','base:Source')).unitUid).toBe(snapshotUnit);
    await publish([{kind:'system.unit',uid:snapshotUnit,key:{},values:{state:'failed'},producer:'fixture',producerVersion:'1'}]);
    await expect(successfulPluginSnapshot(owner,'inherited-run','base:Source')).rejects.toThrow('expected one completed graph unit');
  }finally{await owner.close();}
},30_000);
