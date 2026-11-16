import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { AcpConnection, AcpSession } from '../src/fill/acp.js';
import { PluginAgentBridge } from '../src/plugin/agent.js';
import { canonicalEntity, validateUnitResult } from '../src/plugin/results.js';
import type { PluginEntityRef } from '../src/plugin/protocol.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { createTestDatabaseOwner } from './test-database.js';

test('agent natural-key references survive validation and real graph publication', async () => {
  const contract: GraphContract = { vertex: [
    { name: 'repository', table: generatedTableName('repository', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' },
    { name: 'summary', table: generatedTableName('summary', 'vertex'), key: ['name'], keyEdges: [{role:'repository',edge:'summary-repository',direction:'from',onDelete:'restrict'}], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' },
  ], edge: [{name:'summary-repository',table:generatedTableName('summary-repository','edge'),from:['summary'],to:['repository'],fields:[],repeats:false,capability:'fixture',cardinality:{from:'many',to:'one'},labels:{en:{out:'belongs to',in:'contains'},ru:{out:'принадлежит',in:'содержит'}}}], dictionary: [] };
  const outputs = { vertices: [{ kind: 'summary', key: ['name'], keyEdges: [{role:'repository',edge:'summary-repository',direction:'from' as const,onDelete:'restrict' as const}] }], edges: [{kind:'summary-repository',from:'summary',to:'repository',cardinality:{from:'many' as const,to:'one' as const},labels:{en:{out:'belongs to',in:'contains'},ru:{out:'принадлежит',in:'содержит'}}}] };
  const answer = { vertices: [{ kind: 'summary', key: {name:'A'}, keyEdges: {repository:{kind:'repository',key:{name:'repo'}}}, evidence: { target:{kind:'fixture.evidence',key:{digest:createHash('sha256').update('Source').digest('hex')}}, path: 'a.md', lineStart: 1, lineEnd: 1 } }], edges: [{kind:'summary-repository',from:{kind:'summary',key:{name:'A'},keyEdges:{repository:{kind:'repository',key:{name:'repo'}}}},to:{kind:'repository',key:{name:'repo'}},evidence:{target:{kind:'fixture.evidence',key:{digest:createHash('sha256').update('Source').digest('hex')}},path:'a.md',lineStart:1,lineEnd:1}}], end: { state: 'complete' } };
  const bridge = new PluginAgentBridge({ prompt: 'Extract', roots: ['repo'] }, {
    adapter: { id: 'fixture', command: 'unused' },
    readFile: async () => 'Source',
    evidenceContracts:[{name:'fixture.evidence',evidence:{immutable:true,digestField:'digest',contentField:'content',digestAlgorithm:'sha256'}}],
    connect: async () => ({ initialize: async () => ({}), close: async () => {}, newSession: async () => ({ sessionId: 'fixture', model: null, models: null, configOptions: [], usage: () => ({ reported: false, turns: 1, reports: 0 }), prompt: async () => ({ text: JSON.stringify(answer), stopReason: 'end_turn', updates: [] }) } as unknown as AcpSession) } as unknown as AcpConnection),
  }, { files: async () => [{ kind: 'file', key: { path: 'a.md' }, keyEdges:{'code.file-repository':{kind:'repository',key:{name:'repo'}}} }], value: async (kind: string, _key: PluginEntityRef['key'], field: string) => kind === 'fixture.evidence' ? 'Source' : field === 'blob' ? 'blob-a.md' : null }, outputs);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const result = await bridge.run('unit', {});
    expect(result.vertices,JSON.stringify(result)).toHaveLength(1);
    expect(result.edges).toHaveLength(1);
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, { vertices: [
      { kind: 'repository', key: { name: 'repo' }, producer: 'fixture', producerVersion: '1' },
      ...result.vertices!.map((vertex) => ({ ...vertex, producer: 'fixture', producerVersion: '1', evidence: [] })),
    ], edges: result.edges!.map(edge => ({...edge,producer:'fixture',producerVersion:'1',evidence:[]})), removals: [] }));
    const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ key: unknown }>("SELECT key FROM node WHERE entity_id = (SELECT id FROM entity WHERE name = 'summary')"));
    expect(rows.rows).toEqual([{ key: {name:'A'} }]);
    const edges = await owner.transaction('snapshot', async tx => await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM edge WHERE entity_id = (SELECT id FROM entity WHERE name = 'summary-repository')"));
    expect(edges.rows).toEqual([{count:1}]);
  } finally { await bridge.close(); await owner.close(); }
}, 20_000);

test('key-edge identity sorting is recursive and includes roles', () => {
  const good: PluginEntityRef = {kind:'summary',key:{name:'A'},keyEdges:{repository:{kind:'repository',key:{name:'repo',region:'one'}}}};
  const reordered: PluginEntityRef = {kind:'summary',key:{name:'A'},keyEdges:{repository:{kind:'repository',key:{region:'one',name:'repo'}}}};
  expect(canonicalEntity(good)).toBe(canonicalEntity(reordered));
  const contract = {vertices:[{kind:'summary',key:['name'],keyEdges:[{role:'repository',edge:'summary-repository',direction:'from' as const,onDelete:'restrict' as const}]}],edges:[]};
  const duplicate = validateUnitResult(contract,{unitId:'unit',vertices:[good,reordered],end:{state:'complete'}});
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.refusal.code).toBe('duplicate-vertex');
});
