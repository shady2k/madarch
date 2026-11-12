import { expect, test } from 'bun:test';
import { pluginInvocationAccess } from '../src/plugin/fill-access.js';
import { PluginAgentBridge } from '../src/plugin/agent.js';
import { valueFromPluginSnapshot } from '../src/graph/plugin-turns.js';

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
  const saved = [{ kind: 'vertex', value: { kind: 'Source', key: { id: 'x' }, values: { text: 'original' }, producer: 'base', producerVersion: 'v1' } }];
  let seen: unknown;
  const snapshot = { runId: 'run', unitId: 'plugin-turns/base:Source', generation: 1 };
  const access = pluginInvocationAccess({ files: async () => [], value: async (kind, key, field, token) => {
    seen = token;
    return valueFromPluginSnapshot(saved, kind, key, field);
  } }, { location: '/product/plugin.json:7', plugin: 'summary', output: 'Summary', fields: ['text'], reads: [{ kind: 'Source', version: 'earlier', producer: 'base' }], snapshots: new Map([['Source', snapshot]]), catalogueKinds: ['Source'], fileKind: 'File', edges: [] });
  expect(await access.graph.value('Source', { id: 'x' }, 'text')).toBe('original');
  expect(seen).toEqual(snapshot);
  expect(valueFromPluginSnapshot(saved, 'Source', { id: 'missing' }, 'text')).toBeNull();
  expect(valueFromPluginSnapshot(saved, 'Source', { id: 'x' }, 'omitted')).toBeNull();
});

test('snapshot resolver rejects prior-run or unsuccessful generations before execution', async () => {
  const { successfulPluginSnapshot } = await import('../src/graph/plugin-turns.js');
  let parameters: readonly unknown[] = [];
  const owner = { transaction: async (_mode: string, run: (tx: unknown) => Promise<unknown>) => await run({ query: async (_sql: string, values: readonly unknown[]) => { parameters = values; return { rows: [] }; } }) };
  await expect(successfulPluginSnapshot(owner as never, 'run-current', 'base:Source')).rejects.toThrow('no successful current-run snapshot');
  expect(parameters).toEqual(['run-current', 'base:Source']);
});
