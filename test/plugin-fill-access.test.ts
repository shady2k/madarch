import { expect, test } from 'bun:test';
import { pluginInvocationAccess } from '../src/plugin/fill-access.js';
import { PluginAgentBridge } from '../src/plugin/agent.js';
import { trackedPluginAnswerer, pluginGraphAnswerer } from '../src/fill/plugin-turns.js';

function setup(output: string, reads: string[], fields = ['text']) {
  const calls: string[] = [];
  const access = pluginInvocationAccess({
    files: async () => { calls.push('files'); return []; },
    value: async (kind) => { calls.push(kind); return kind; },
    unresolved: async () => { calls.push('unresolved'); return { references: [] }; },
  }, { location: '/product/plugin.json:7', plugin: 'multi', output, reads, fields, catalogueKinds: ['X', 'Y'], fileKind: 'File', edges: [] });
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

test('unfilterable catalogue pages refuse before reading undeclared kinds', async () => {
  const { access, calls } = setup('A', ['X']);
  await expect(access.graph.unresolved!({})).rejects.toThrow('undeclared catalogue read of Y');
  expect(calls).toEqual([]);
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
  const savedValue = (kind: string, key: { readonly id?: string }, field: string): unknown => {
    const vertex = saved.find(vertex => vertex.kind === kind && vertex.key.id === key.id);
    return (vertex?.values as Readonly<Record<string, unknown>> | undefined)?.[field] ?? null;
  };
  let seen: unknown;
  const snapshot = { runId: 'run', unitId: 'plugin-turns/base:Source', generation: 1 };
  const access = pluginInvocationAccess({ files: async () => [], value: async (kind, key, field, token) => {
    seen = token;
    return savedValue(kind, key, field);
  } }, { location: '/product/plugin.json:7', plugin: 'summary', output: 'Summary', fields: ['text'], reads: [{ kind: 'Source', version: 'earlier', producer: 'base' }], snapshots: new Map([['Source', snapshot]]), catalogueKinds: ['Source'], fileKind: 'File', edges: [] });
  expect(await access.graph.value('Source', { id: 'x' }, 'text')).toBe('original');
  expect(seen).toEqual(snapshot);
  expect(savedValue('Source', { id: 'missing' }, 'text')).toBeNull();
  expect(savedValue('Source', { id: 'x' }, 'omitted')).toBeNull();
});

test('earlier file enumeration forwards the exact named snapshot and refuses missing snapshots', async () => {
  const snapshot = { runId: 'original', unitId: 'plugin-turns/base:File', generation: 2 };
  const calls: unknown[] = [];
  const graph = { files: async (pattern: string, token?: typeof snapshot) => { calls.push([pattern, token]); return [{ kind: 'File', key: { path: 'saved.ts' } }]; }, value: async () => null };
  const scope = { location: '/product/plugin.json:7', plugin: 'refiner', output: 'File', fields: [], reads: [{ kind: 'File', version: 'earlier' as const, producer: 'base' }], catalogueKinds: ['File'], fileKind: 'File', edges: [] };
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
  const snapshot = { runId: 'saved', unitId: 'plugin-turns/base:File', generation: 1 };
  await graph.files('**', snapshot);
  expect(requests.map(({ method, args }) => ({ method, args }))).toEqual([
    { method: 'files', args: ['**'] },
    { method: 'value', args: ['File', { path: 'a' }, 'text'] },
    { method: 'files', args: ['**', snapshot] },
  ]);
});

test('one reader indexes immutable snapshot files and fields once without sharing with another reader', async () => {
  const snapshot = { runId: 'saved', unitId: 'plugin-turns/base:code.file', generation: 1 };
  let loads = 0;
  const writes = [{ kind: 'vertex', value: { kind: 'code.file', key: { repository: 'repo', path: 'a.ts' }, values: { content: 'saved', language: 'typescript' } } }];
  const owner = { transaction: async (_mode: string, run: (tx: unknown) => Promise<unknown>) => await run({ query: async (sql: string) => {
    if (sql.includes('FROM fill_unit_draft d')) { loads++; return { rows: [{ unit_id: snapshot.unitId, generation: 1, writes }] }; }
    return { rows: [] };
  } }) };
  const wiring = { owner, manifest: {}, contract: {} } as unknown as Parameters<typeof pluginGraphAnswerer>[0];
  const reader = pluginGraphAnswerer(wiring);
  const key = { repository: 'repo', path: 'a.ts' };
  expect(await reader.files('**/*.ts', snapshot)).toEqual([{ kind: 'code.file', key }]);
  expect(await reader.value('code.file', key, 'content', snapshot)).toBe('saved');
  expect(await reader.value('code.file', key, 'language', snapshot)).toBe('typescript');
  expect(await reader.value('code.file', key, 'omitted', snapshot)).toBeNull();
  expect(loads).toBe(1);
  expect(await pluginGraphAnswerer(wiring).value('code.file', key, 'content', snapshot)).toBe('saved');
  expect(loads).toBe(2);
});

test('snapshot resolver rejects prior-run or unsuccessful generations before execution', async () => {
  const { successfulPluginSnapshot } = await import('../src/graph/plugin-turns.js');
  let parameters: readonly unknown[] = [];
  const owner = { transaction: async (_mode: string, run: (tx: unknown) => Promise<unknown>) => await run({ query: async (_sql: string, values: readonly unknown[]) => { parameters = values; return { rows: [] }; } }) };
  await expect(successfulPluginSnapshot(owner as never, 'run-current', 'base:Source')).rejects.toThrow('no successful current-run snapshot');
  expect(parameters).toEqual(['run-current', 'base:Source']);
});

test('verified inherited generation freezes original run identity without cloning publication', async () => {
  const { successfulPluginSnapshot } = await import('../src/graph/plugin-turns.js');
  const queries: string[] = [];
  const owner = { transaction: async (_mode: string, run: (tx: unknown) => Promise<unknown>) => await run({ query: async (query: string) => {
    queries.push(query);
    if (queries.length > 1) return { rows: [] };
    return { rows: [{ run_id: 'original-run', unit_id: 'plugin-turns/base:Source', generation: 3, writes: [{ kind: 'producer-outcome', value: { outcome: 'unchanged' } }] }] };
  } }) };
  expect(await successfulPluginSnapshot(owner as never, 'new-run', 'base:Source')).toEqual({ runId: 'original-run', unitId: 'plugin-turns/base:Source', generation: 3 });
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain("e.kind = 'unit-inherited'");
  expect(queries[0]).toContain('e.generation = g.generation');
  expect(queries[1]).toContain('FROM fill_unit_draft_part');
});
