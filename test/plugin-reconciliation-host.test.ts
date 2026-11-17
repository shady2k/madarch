import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginHost, type GraphAnswerer } from '../src/plugin/host.js';
import { closureOf } from '../src/plugin/closure.js';

async function run(source: string, readOnly = false, graph?: GraphAnswerer) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-reconciliation-host-'));
  try {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'writer-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, readOnly, produces: [{ kind: 'Probe', fields: '*' }] }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
      await definePlugin({ name:'writer-probe',version:'1.0.0',readOnly:${readOnly},graph:true,graphReads:['ownFacts','files','value'],contract:{vertices:[{kind:'Probe',key:['id']}],edges:[{kind:'link',from:'Probe',to:'Probe',cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked'},ru:{out:'связан',in:'связан'}}}]},async extract(unit,context){${source}} });`);
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'writer-probe', version: '1.0.0', outputs: { vertices: [{kind:'Probe',key:['id']}], edges:[{kind:'link',from:'Probe',to:'Probe',cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked'},ru:{out:'связан',in:'связан'}}}] }, rights: {network:'none',graph:true,graphReads:['ownFacts','files','value']} }));
    const closure = closureOf(root);
    const operations: import('../src/plugin-sdk.js').FactsOperation[] = [];
    let removed = false;
    const liveGraph = graph === undefined ? undefined : { ...graph, ownFacts: async (query: Parameters<NonNullable<GraphAnswerer['ownFacts']>>[0]) => removed ? { vertices: [], edges: [] } : await graph.ownFacts!(query) };
    const host = new PluginHost({ operations: { async apply(_unit, _key, operation) { operations.push(operation as import('../src/plugin-sdk.js').FactsOperation); removed = true; return { accepted: true }; } }, pluginFolder: root, closure, repository: root, workRoot: join(root, 'work'), trust: 'production', releaseHashes: [closure.hash], env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' }, graph: liveGraph });
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
