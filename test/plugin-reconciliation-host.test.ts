import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginHost, type GraphAnswerer } from '../src/plugin/host.js';
import { closureOf } from '../src/plugin/closure.js';

async function run(source: string, readOnly = false, graph?: GraphAnswerer, retainApplied = false, failApplyAt?: number) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-reconciliation-host-'));
  try {
    probeFolder(root, source, readOnly);
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

/** One writer probe's folder: its declaration, its contract and the one function its session runs. */
function probeFolder(root: string, source: string, readOnly = false): void {
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'writer-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, readOnly, produces: [{ kind: 'Probe', fields: '*' }] }));
  writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
      await definePlugin({ name:'writer-probe',version:'1.0.0',readOnly:${readOnly},graph:true,graphReads:['ownFacts','files','value'],contract:{vertices:[{kind:'Probe',key:['id']}],edges:[{kind:'link',from:'Probe',to:'Probe',cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked'},ru:{out:'связан',in:'связан'}}}]},async extract(unit,context){${source}} });`);
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'writer-probe', version: '1.0.0', outputs: { vertices: [{kind:'Probe',key:['id']}], edges:[{kind:'link',from:'Probe',to:'Probe',cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked'},ru:{out:'связан',in:'связан'}}}] }, rights: {network:'none',graph:true,graphReads:['ownFacts','files','value']} }));
}

/**
 * The graph a reconcile reads, behaving as the one writer does for the two things its batch is decided from: the receipt
 * a key already answered, and this source's stream position for each subject (0039 item 24). A precondition that names
 * another sequence than the stream holds is refused with `REVISION_CONFLICT`, and a replayed key answers its receipt.
 */
function streamWriter() {
  type Key = Readonly<Record<string, string | number | boolean>>;
  type Held = { readonly kind: string; readonly key: Key; readonly values?: Readonly<Record<string, unknown>>; readonly present: boolean; readonly sequence: number };
  const facts = new Map<string, Held>();
  const receipts = new Map<string, string>();
  const operations: import('../src/plugin-sdk.js').FactsOperation[] = [];
  const hooks: { onApply?: (call: number) => void } = {};
  let sequence = 0;
  let calls = 0;
  let reads = 0;
  let conflicts = 0;
  const identity = (kind: string, key: Key): string => `${kind}:${JSON.stringify(key)}`;
  const write = (kind: string, key: Key, values: Readonly<Record<string, unknown>> | undefined, present: boolean): void => {
    sequence += 1;
    facts.set(identity(kind, key), { kind, key, ...(values === undefined ? {} : { values }), present, sequence });
  };
  return {
    hooks,
    write,
    facts,
    operations,
    numeric: () => ({ reads, conflicts, calls, writes: operations.length }),
    graph: {
      ownFacts: async () => {
        reads += 1;
        return {
          vertices: [...facts.values()].filter(fact => fact.present).map(fact => ({ kind: fact.kind, key: fact.key, ...(fact.values === undefined ? {} : { values: fact.values }) })),
          edges: [],
          revisions: [...facts.values()].map(fact => ({ subject: { sort: 'vertex' as const, kind: fact.kind, key: fact.key }, recordedSequence: String(fact.sequence) })),
          coverage: { vertices: { kind: 'Probe' }, edges: [] },
        };
      },
      files: async () => [],
      value: async () => null,
    } as GraphAnswerer,
    apply: async (_unit: string, key: string, operation: import('../src/plugin-sdk.js').FactsOperation, preconditions?: readonly import('../src/plugin/protocol.js').PluginPrecondition[]) => {
      calls += 1;
      const request = JSON.stringify({ operation, preconditions: preconditions ?? [] });
      const receipt = receipts.get(key);
      if (receipt !== undefined) {
        if (receipt !== request) throw new Error('IDEMPOTENCY_CONFLICT');
        return { receipt: true };
      }
      hooks.onApply?.(calls);
      for (const condition of preconditions ?? []) {
        if (condition.subject.sort !== 'vertex') continue;
        const held = facts.get(identity(condition.subject.kind, condition.subject.key));
        if (String(held?.sequence ?? 0) !== (condition.recordedSequence ?? '0')) {
          conflicts += 1;
          throw Object.assign(new Error(`REVISION_CONFLICT ${condition.subject.kind}`), { code: 'REVISION_CONFLICT' });
        }
      }
      receipts.set(key, request);
      operations.push(operation);
      for (const vertex of operation.vertices ?? []) write(vertex.kind, vertex.key, vertex.values, true);
      for (const removal of operation.removals ?? []) write(removal.kind, removal.key, undefined, false);
      return { accepted: true };
    },
  };
}

/** Runs one probe unit against the stub writer: the unit's outcome, and every count the stub kept. */
async function runStream(source: string, writer: ReturnType<typeof streamWriter>) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-reconciliation-stream-'));
  try {
    probeFolder(root, source);
    const closure = closureOf(root);
    const host = new PluginHost({ operations: { apply: writer.apply }, pluginFolder: root, closure, repository: root, workRoot: join(root, 'work'), trust: 'production', releaseHashes: [closure.hash], env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' }, graph: writer.graph });
    const session = await host.open();
    try { return await session.runUnit({ unitId: 'u1', kind: 'Probe', key: { id: 'one' }, inputs: { repositories: [{ repository: 'sample', commit: 'current' }] } }); }
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

test('a cycle inside one unit leaves the subject present: the second add is a different operation', async () => {
  // 0039 item 24: the key of a batch is the digest of its canonical request, preconditions included. The third batch's
  // read holds the retraction's sequence, so it is a different operation than the first — not a reply of its receipt.
  const writer = streamWriter();
  const outcome = await runStream(`const at=(text)=>({vertices:[{kind:'Probe',key:{id:'one'},values:{text}}],end:{state:'complete'}});
    await context.reconcile(at('first'),{});
    await context.reconcile({end:{state:'complete'}},{});
    await context.reconcile(at('first'),{});
    return {end:{state:'complete'}};`, writer);
  expect(outcome.state).toBe('extracted');
  expect(writer.operations.map(operation => Object.keys(operation))).toEqual([['vertices'], ['removals'], ['vertices']]);
  expect(writer.facts.get('Probe:{"id":"one"}')).toMatchObject({ present: true, values: { text: 'first' } });
  expect(writer.numeric()).toEqual({ reads: 3, conflicts: 0, calls: 3, writes: 3 });
});

test('a stale read is refused with REVISION_CONFLICT, then reread and replanned to the source answer', async () => {
  // The graph moved between the read and the write: a competing batch of the same source stated the subject. The writer
  // refuses the planned batch, and the SDK reads the graph again and writes only what still differs.
  const writer = streamWriter();
  writer.hooks.onApply = (call) => { if (call === 1) writer.write('Probe', { id: 'one' }, { text: 'concurrent' }, true); };
  const outcome = await runStream(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'},values:{text:'first'}}],end:{state:'complete'}},{}); return {end:{state:'complete'}};`, writer);
  expect(outcome.state).toBe('extracted');
  expect(writer.numeric()).toEqual({ reads: 2, conflicts: 1, calls: 2, writes: 1 });
  expect(writer.operations.map(operation => Object.keys(operation))).toEqual([['vertices']]);
  expect(writer.facts.get('Probe:{"id":"one"}')).toMatchObject({ present: true, values: { text: 'first' } });
});

test('a writer that keeps contending ends the unit instead of replanning for ever', async () => {
  const writer = streamWriter();
  writer.hooks.onApply = () => { writer.write('Probe', { id: 'one' }, { text: 'contended' }, true); };
  const outcome = await runStream(`await context.reconcile({vertices:[{kind:'Probe',key:{id:'one'},values:{text:'first'}}],end:{state:'complete'}},{}); return {end:{state:'complete'}};`, writer);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.message).toContain('REVISION_CONFLICT');
  expect(writer.numeric()).toEqual({ reads: 3, conflicts: 3, calls: 3, writes: 0 });
});

test('batches of one read never conflict on the subjects another batch wrote', async () => {
  // Per-subject preconditions, not a scope-wide revision: the second batch of one read names only its own subjects, so
  // the first batch's writes never make it stale.
  const writer = streamWriter();
  const outcome = await runStream(`await context.reconcile({vertices:Array.from({length:501},(_,index)=>({kind:'Probe',key:{id:String(index).padStart(3,'0')}})),end:{state:'complete'}},{}); return {end:{state:'complete'}};`, writer);
  expect(outcome.state).toBe('extracted');
  expect(writer.numeric()).toEqual({ reads: 1, conflicts: 0, calls: 2, writes: 2 });
  expect(writer.operations.map(operation => operation.vertices?.length)).toEqual([500, 1]);
});
