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

test('consistency record reads preserve bounded pages without requiring catalogue content inputs', async () => {
  const calls: unknown[] = [];
  const query = { after: 'cursor', limit: 1 };
  const access = pluginInvocationAccess({
    files: async () => [], value: async () => null,
    unresolved: async (page) => { calls.push(['unresolved', page]); return { references: [], next: 'references-next' }; },
    removedEnds: async (page) => { calls.push(['removedEnds', page]); return { edges: [], next: 'edges-next' }; },
    unevidenced: async (page) => { calls.push(['unevidenced', page]); return { opinions: [], next: 'opinions-next' }; },
  }, { location: '/product/plugin.json:7', plugin: 'consistency', output: 'Finding', reads: [], fields: [], fileKind: 'File', edges: [] });
  expect(await access.graph.unresolved!(query)).toEqual({ references: [], next: 'references-next' });
  expect(await access.graph.removedEnds!(query)).toEqual({ edges: [], next: 'edges-next' });
  expect(await access.graph.unevidenced!(query)).toEqual({ opinions: [], next: 'opinions-next' });
  expect(calls).toEqual([['unresolved', query], ['removedEnds', query], ['unevidenced', query]]);
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

test('a declared earlier read answers the graph as it stands, naming its producer', async () => {
  // There is no stored generation to freeze any more (decision 0039, item 13): a read declared as an earlier
  // version of one producer's answer reads the graph, and the declaration still names the producer it depends on.
  const saved = [{ kind: 'Source', key: { id: 'x' }, values: { text: 'original' } }];
  let reads = 0;
  const access = pluginInvocationAccess({ files: async () => [], value: async (kind, key, field) => {
    reads += 1;
    const vertex = saved.find((one) => one.kind === kind && one.key.id === key.id);
    return (vertex?.values as Readonly<Record<string, unknown>> | undefined)?.[field] ?? null;
  } }, { location: '/product/plugin.json:7', plugin: 'summary', output: 'Summary', fields: ['text'], reads: [{ kind: 'Source', version: 'earlier', producer: 'base' }], fileKind: 'File', edges: [] });
  expect(await access.graph.value('Source', { id: 'x' }, 'text')).toBe('original');
  expect(reads).toBe(1);
  await expect(access.graph.value('Elsewhere', { id: 'x' }, 'text')).rejects.toThrow('undeclared catalogue read of Elsewhere');
});

test('earlier file enumeration reads the graph the plugin declared', async () => {
  const calls: string[] = [];
  const graph = { files: async (pattern: string) => { calls.push(pattern); return [{ kind: 'File', key: { path: 'saved.ts' } }]; }, value: async () => null };
  const scope = { location: '/product/plugin.json:7', plugin: 'refiner', output: 'File', fields: [], reads: [{ kind: 'File', version: 'earlier' as const, producer: 'base' }], fileKind: 'File', edges: [] };
  const access = pluginInvocationAccess(graph, scope);
  expect(await access.graph.files('**/*.ts')).toEqual([{ kind: 'File', key: { path: 'saved.ts' } }]);
  expect(calls).toEqual(['**/*.ts']);
});

test('tracked optional graph arguments remain absent rather than becoming JSON null', async () => {
  const requests: { method: string; args: unknown[] }[] = [];
  const graph = trackedPluginAnswerer({ query: async (text) => { requests.push(JSON.parse(text)); return [[]]; } });
  await graph.files('**');
  await graph.value('File', { path: 'a' }, 'text');
  expect(requests.map(({ method, args }) => ({ method, args }))).toEqual([
    { method: 'files', args: ['**'] },
    { method: 'value', args: ['File', { path: 'a' }, 'text'] },
  ]);
});

test('the host reader answers files and fields from the graph as it stands', async () => {
  const owner = { transaction: async (_mode: string, run: (tx: unknown) => Promise<unknown>) => await run({ query: async (_sql: string, values: readonly unknown[]) => {
    // The file read names its kind and its containment edge; a field read names the key it asks about.
    if (values.length === 2) return { rows: [{ repository: 'repo', path: 'a.ts' }] };
    return { rows: [{ value: 'saved' }] };
  } }) };
  const wiring = { owner, manifest: {}, contract: { vertex: [{ name: 'code.file', table: 'k_code_file', key: ['repository', 'path'], fields: [{ name: 'content', type: 'text' }] }], edge: [], dictionary: [] } } as unknown as Parameters<typeof pluginGraphAnswerer>[0];
  const reader = pluginGraphAnswerer(wiring);
  expect(await reader.files('*.ts')).toEqual([{ kind: 'code.file', key: { repository: 'repo', path: 'a.ts' } }]);
  expect(await reader.value('code.file', { repository: 'repo', path: 'a.ts' }, 'content')).toBe('saved');
});
