import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginHost, type GraphAnswerer } from '../src/plugin/host.js';
import { closureOf } from '../src/plugin/closure.js';

async function run(source: string, readOnly = false, graph?: GraphAnswerer, retainApplied = false, failApplyAt?: number) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-reconciliation-host-'));
  try {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'writer-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, readOnly, produces: [{ kind: 'Probe', fields: '*' }] }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
      await definePlugin({ name:'writer-probe',version:'1.0.0',readOnly:${readOnly},graph:true,graphReads:['ownFacts','files','value'],contract:{vertices:[{kind:'Probe',key:['id']}],edges:[{kind:'link',from:'Probe',to:'Probe',cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked'},ru:{out:'связан',in:'связан'}}}]},async extract(unit,context){${source}} });`);
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'writer-probe', version: '1.0.0', outputs: { vertices: [{kind:'Probe',key:['id']}], edges:[{kind:'link',from:'Probe',to:'Probe',cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked'},ru:{out:'связан',in:'связан'}}}] }, rights: {network:'none',graph:true,graphReads:['ownFacts','files','value']} }));
    const closure = closureOf(root);
    const operations: import('../src/plugin-sdk.js').FactsOperation[] = [];
    let removed = false;
    let applyCalls = 0;
    const liveGraph = graph === undefined ? undefined : { ...graph, ownFacts: async (query: Parameters<NonNullable<GraphAnswerer['ownFacts']>>[0]) => retainApplied ? { vertices: operations.flatMap(operation => operation.vertices ?? []), edges: [] } : removed ? { vertices: [], edges: [] } : await graph.ownFacts!(query) };
    const host = new PluginHost({ operations: { async apply(_unit, _key, operation) { if (++applyCalls === failApplyAt) throw new Error('injected batch failure'); operations.push(operation as import('../src/plugin-sdk.js').FactsOperation); removed = true; return { accepted: true }; } }, pluginFolder: root, closure, repository: root, workRoot: join(root, 'work'), trust: 'production', releaseHashes: [closure.hash], env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' }, graph: liveGraph });
    const session = await host.open();
    try { const outcome = await session.runUnit({ unitId: 'u1', kind: 'Probe', key: { id: 'one' }, inputs: { repositories: [{ repository: 'sample', commit: 'current' }] } }); return { outcome, operations }; }
    finally { await session.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const graph: GraphAnswerer = { files: async () => [], value: async () => null, ownFacts: async () => ({ vertices: [], edges: [] }) };

test('read-only plugins cannot return graph facts', async () => {
  const { outcome } = await run(`return {vertices:[{kind:'Probe',key:{id:'one'}}],end:{state:'complete'}};`, true);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('malformed-result');
});

test('own facts are answered for the active unit through declared graph access', async () => {
  const { outcome } = await run(`const facts=await context.graph.ownFacts({}); if(facts.vertices.length) throw new Error('unexpected facts'); return {end:{state:'complete'}};`, false, graph);
  expect(outcome.state).toBe('extracted');
});

test('read-only plugins cannot stage reconciliation writes', async () => {
  const { outcome } = await run(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'},evidence:{target:{kind:'blob',key:{digest:'retained'}},path:'source.md'}}],end:{state:'complete'}},{}); return {end:{state:'complete'}};`, true, graph);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.message).toContain('read-only');
});

test('explicit edge removals retain operation and immutable historical evidence', async () => {
  const { outcome, operations } = await run(`await context.reconcile({end:{state:'complete'}},{repository:'sample',commit:'current',parent:{kind:'code.repository',key:{name:'sample'}}}); return {end:{state:'complete'}};`, false, {
    ...graph,
    ownFacts: async () => ({ vertices: [], edges: [{ kind: 'link', from: {kind:'Probe',key:{id:'one'},keyEdges:{repository:{kind:'code.repository',key:{name:'sample'}}}}, to:{kind:'Probe',key:{id:'two'},keyEdges:{repository:{kind:'code.repository',key:{name:'sample'}}}},evidence:{target:{kind:'blob',key:{digest:'retained'}},commit:'old',path:'source.md'} }] }),
  });
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(operations).toHaveLength(1);
  expect(operations[0]?.edgeRemovals?.[0]).toMatchObject({ kind: 'link', evidence: { target: { kind: 'blob', key: { digest: 'retained' } }, commit: 'old' } });
  expect(outcome.result).not.toHaveProperty('writes');
});

test('an immediate operation is not retracted by its empty terminal answer', async () => {
  const { outcome, operations } = await run(`await context.facts.apply('publish',{vertices:[{kind:'Probe',key:{id:'one'}}]}); return {end:{state:'complete'}};`, false, graph, true);
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([{ vertices: [{ kind: 'Probe', key: { id: 'one' } }] }]);
});

test('explicit reconciliation facts survive a nonempty terminal answer', async () => {
  const { outcome, operations } = await run(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'}}],end:{state:'complete'}},{}); return {vertices:[{kind:'Probe',key:{id:'two'}}],end:{state:'complete'}};`, false, graph, true);
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([
    { vertices: [{ kind: 'Probe', key: { id: 'one' } }] },
    { vertices: [{ kind: 'Probe', key: { id: 'two' } }] },
  ]);
});

test('unchanged reconciled vertex survives a nonempty terminal answer on a repeated run', async () => {
  const { outcome, operations } = await run(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'}}],end:{state:'complete'}},{}); return {vertices:[{kind:'Probe',key:{id:'two'}}],end:{state:'complete'}};`, false, {
    ...graph, ownFacts: async () => ({ vertices: [{ kind: 'Probe', key: { id: 'one' } }], edges: [] }),
  });
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([{ vertices: [{ kind: 'Probe', key: { id: 'two' } }] }]);
});

test('unchanged reconciled edge survives a nonempty terminal answer on a repeated run', async () => {
  const endpoint = { kind: 'Probe', key: { id: 'one' } };
  const { outcome, operations } = await run(`await context.reconcile({edges:[{kind:'link',from:{kind:'Probe',key:{id:'one'}},to:{kind:'Probe',key:{id:'one'}}}],end:{state:'complete'}},{}); return {vertices:[{kind:'Probe',key:{id:'two'}}],end:{state:'complete'}};`, false, {
    ...graph, ownFacts: async () => ({ vertices: [], edges: [{ kind: 'link', from: endpoint, to: endpoint }] }),
  });
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([{ vertices: [{ kind: 'Probe', key: { id: 'two' } }] }]);
});

test('changed reconciled values survive a nonempty terminal answer', async () => {
  const { outcome, operations } = await run(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'},values:{text:'new'}}],end:{state:'complete'}},{}); return {vertices:[{kind:'Probe',key:{id:'two'}}],end:{state:'complete'}};`, false, {
    ...graph, ownFacts: async () => ({ vertices: [{ kind: 'Probe', key: { id: 'one' }, values: { text: 'old' } }], edges: [] }),
  }, true);
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([
    { vertices: [{ kind: 'Probe', key: { id: 'one' }, values: { text: 'new' } }] },
    { vertices: [{ kind: 'Probe', key: { id: 'two' } }] },
  ]);
});

test('a later reconciliation can retire a previously confirmed unchanged fact', async () => {
  const { outcome, operations } = await run(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'}}],end:{state:'complete'}},{}); await context.reconcile({end:{state:'complete'}},{}); return {vertices:[{kind:'Probe',key:{id:'two'}}],end:{state:'complete'}};`, false, {
    ...graph, ownFacts: async () => ({ vertices: [{ kind: 'Probe', key: { id: 'one' } }], edges: [] }),
  });
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([
    { removals: [{ kind: 'Probe', key: { id: 'one' } }] },
    { vertices: [{ kind: 'Probe', key: { id: 'two' } }] },
  ]);
});

test('a caught failure in the second reconciliation batch retains only accepted facts', async () => {
  const { outcome, operations } = await run(`let failed=false; try { await context.reconcile({vertices:Array.from({length:501},(_,i)=>({kind:'Probe',key:{id:String(i).padStart(3,'0')}})),end:{state:'complete'}},{}); } catch(error) { if(!error.message.includes('injected batch failure')) throw error; failed=true; } if(!failed) throw new Error('expected batch failure'); return {vertices:[{kind:'Probe',key:{id:'terminal'}}],end:{state:'complete'}};`, false, graph, true, 2);
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([
    { vertices: Array.from({ length: 500 }, (_, i) => ({ kind: 'Probe', key: { id: String(i).padStart(3, '0') } })) },
    { vertices: [{ kind: 'Probe', key: { id: 'terminal' } }] },
  ]);
});

test('terminal duplicate identities are refused after immediate writes', async () => {
  const { outcome } = await run(`await context.facts.apply('publish',{vertices:[{kind:'Probe',key:{id:'one'}}]}); return {vertices:[{kind:'Probe',key:{id:'one'}},{kind:'Probe',key:{id:'one'}}],end:{state:'complete'}};`, false, graph, true);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.message).toContain('duplicate vertex identity');
});

test('empty terminal arrays do not widen explicit reconciliation scope', async () => {
  const { outcome, operations } = await run(`await context.reconcile({end:{state:'complete'}},{parent:{kind:'Probe',key:{id:'one'}}}); return {vertices:[],edges:[],end:{state:'complete'}};`, false, {
    ...graph, ownFacts: async () => ({ vertices: [{ kind: 'Probe', key: { id: 'outside' } }], edges: [] }),
  });
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([]);
});

test('partial reconciliation never applies removals', async () => {
  const { outcome, operations } = await run(`await context.reconcile({end:{state:'partial',cause:'source unreadable'}},{repository:'sample',commit:'current',parent:{kind:'code.repository',key:{name:'sample'}}}); return {end:{state:'partial',cause:'source unreadable'}};`, false, {
    ...graph,
    ownFacts: async () => ({ vertices: [{kind:'Probe',key:{id:'old'},keyEdges:{repository:{kind:'code.repository',key:{name:'sample'}}},evidence:{target:{kind:'blob',key:{digest:'retained'}},path:'source.md'}}], edges: [] }),
  });
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(operations.flatMap(operation => operation.removals ?? [])).toEqual([]);
  expect(operations.flatMap(operation => operation.edgeRemovals ?? [])).toEqual([]);
});

test('reconciliation batches add before retirement and omit incident edge retractions', async () => {
  const existing = {kind:'Probe',key:{id:'old'}};
  const {outcome,operations}=await run(`return {vertices:[{kind:'Probe',key:{id:'new'}}],edges:[{kind:'link',from:{kind:'Probe',key:{id:'new'}},to:{kind:'Probe',key:{id:'new'}}}],end:{state:'complete'}};`,false,{
    ...graph, ownFacts:async()=>({vertices:[existing],edges:[{kind:'link',from:existing,to:existing}]}),
  });
  expect(outcome.state).toBe('extracted');
  expect(operations.map(operation=>Object.keys(operation))).toEqual([['vertices','edges'],['removals']]);
  expect(operations[1]!.removals).toEqual([existing]);
  expect(operations.flatMap(operation=>operation.edgeRemovals??[])).toEqual([]);
});
