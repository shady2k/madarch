import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginHost, type GraphAnswerer } from '../src/plugin/host.js';
import { closureOf } from '../src/plugin/closure.js';

async function run(source: string, readOnly = false, graph?: GraphAnswerer, mismatchRights = false) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-reconciliation-host-'));
  try {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'writer-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, readOnly, produces: [{ kind: 'Probe', fields: '*' }] }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
      await definePlugin({ name:'writer-probe',version:'1.0.0',readOnly:true,graph:true,graphReads:['ownFacts','files','value'],contract:{vertices:[{kind:'Probe',key:['id']}],edges:[{kind:'link',from:'Probe',to:'Probe'}]},async extract(unit,context){${source}} });`);
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'writer-probe', version: '1.0.0', outputs: { vertices: [{kind:'Probe',key:['id']}], edges:[{kind:'link',from:'Probe',to:'Probe'}] }, rights: mismatchRights ? {network:'none'} : {network:'none',graph:true,graphReads:['ownFacts','files','value']} }));
    const closure = closureOf(root);
    const host = new PluginHost({ pluginFolder: root, closure, repository: root, workRoot: join(root, 'work'), trust: 'production', releaseHashes: [closure.hash], env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' }, graph });
    const session = await host.open();
    try { return await session.runUnit({ unitId: 'u1', kind: 'Probe', key: { id: 'one' } }); }
    finally { await session.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const graph: GraphAnswerer = { files: async () => [], value: async () => null, ownFacts: async () => ({ vertices: [], edges: [] }) };

test('an introduction rights mismatch rejects instead of leaving host open pending', async () => {
  await expect(run(`return {end:{state:'complete'}};`, false, graph, true)).rejects.toMatchObject({code:'rights-mismatch'});
});

test('read-only plugins cannot return graph facts', async () => {
  const outcome = await run(`return {vertices:[{kind:'Probe',key:{id:'one'}}],end:{state:'complete'}};`, true);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('writer-denied');
});

test('own facts are answered for the active unit through declared graph access', async () => {
  const outcome = await run(`const facts=await context.graph.ownFacts({}); if(facts.vertices.length) throw new Error('unexpected facts'); return {end:{state:'complete'}};`, false, graph);
  expect(outcome.state).toBe('extracted');
});

test('read-only plugins cannot stage reconciliation writes', async () => {
  const outcome = await run(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'},evidence:{path:'source.md'}}],end:{state:'complete'}},{}); return {end:{state:'complete'}};`, true, graph);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.message).toContain('read-only');
});

test('explicit edge removals retain operation and current evidence', async () => {
  const outcome = await run(`await context.reconcile({end:{state:'complete'}},{repository:'sample',commit:'current'}); return {end:{state:'complete'}};`, false, {
    ...graph,
    ownFacts: async () => ({ vertices: [], edges: [{ kind: 'link', from: {kind:'Probe',key:{id:'one'}}, to:{kind:'Probe',key:{id:'two'}},evidence:{repository:'sample',commitOrDigest:'old',path:'source.md'} }] }),
  });
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(outcome.result.writes).toHaveLength(1);
  expect(outcome.result.writes?.[0]?.operation).toBe('remove');
  expect(outcome.result.writes?.[0]?.edge?.kind).toBe('link');
  expect(outcome.result.writes?.[0]?.evidence.commitOrDigest).toBe('current');
});

test('partial units never publish staged removals', async () => {
  const outcome = await run(`await context.reconcile({end:{state:'complete'}},{repository:'sample',commit:'current'}); return {end:{state:'partial',cause:'source unreadable'}};`, false, {
    ...graph,
    ownFacts: async () => ({ vertices: [{kind:'Probe',key:{id:'old'},evidence:{repository:'sample',path:'source.md'}}], edges: [] }),
  });
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(outcome.result.writes).toEqual([]);
});
