import { expect, test } from 'bun:test';
import { parsePluginManifest } from '../src/plugin/closure.js';
import { planFillDeclarations, planManifestFill } from '../src/plugin/fill-declarations.js';
import { createPluginTurnStage, planPluginTurns, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';

const base = { version: '1.0.0', entry: 'index.ts', runtime: { name: 'bun', version: Bun.version } };
function plugin(name: string, produces: unknown[] = [{ kind: 'File', fields: '*' }], agent = false) {
  const text = JSON.stringify({ ...base, name, produces, ...(agent ? { agent: { prompt: 'Fill.', roots: ['product'], catalogue: true } } : {}) }, null, 2);
  return { manifest: parsePluginManifest(text, `/product/${name}/plugin.json`), file: `/product/${name}/plugin.json`, text };
}
const kind = (name: string, fields = ['title', 'description'], derivesFrom: string[] = []) => ({ name, fields, derivesFrom, file: '/product/kinds.yaml', line: name === 'File' ? 4 : 9 });
const kinds = [kind('File')];
const output = (name: string, fields: '*' | string[] = '*', extra = {}) => ({ kind: name, fields, ...extra });
const general = () => plugin('general', [output('*', '*', { coverage: 'gaps' })], true);
function manifestOf(catalogue: ReturnType<typeof kind>[], declarations: ReturnType<typeof plugin>[]): KindsManifest {
  return {
    file: '/product/kinds.yaml',
    kinds: new Map(catalogue.map((entry) => [entry.name, { ...entry, fields: entry.fields.map((name) => ({ name, type: 'text' })) }])),
    plugins: new Map(declarations.map((entry) => [entry.manifest.name, { id: entry.manifest.name, declaration: entry.manifest, declarationFile: entry.file, declarationText: entry.text }])),
  } as unknown as KindsManifest;
}

test('vertex selection scopes the target unit but not its ordinary prerequisites', async () => {
  const manifest = manifestOf([kind('File'), kind('Summary', ['description'], ['File'])], [
    plugin('index'), plugin('summary', [output('Summary', '*', { reads: ['File'] })]),
  ]);
  const wiring = { manifest, productFolder: '/product', targets: { kinds: ['Summary'], vertex: 'Summary:one' },
    locks: new Map(['index', 'summary'].map((id) => [id, { id, version: '1.0.0', closure: 'a'.repeat(64), path: `plugins/${id}`, line: 1 }])),
  } as unknown as PluginTurnWiring;
  const units = await planPluginTurns(wiring);
  expect(units.map((unit) => unit.id)).toEqual(['index:File', 'summary:Summary@Summary:one']);
  const stage = createPluginTurnStage(wiring);
  expect(stage.unitScheduling!('summary:Summary@Summary:one').after).toEqual(['index:File']);
});

test('S1: universal agent capability does not schedule covered deterministic output', () => {
  const plan = planFillDeclarations({ kinds, plugins: [plugin('index'), general()], selectedKinds: ['File'], agentSelected: false });
  expect(plan.order).toEqual(['index']);
  expect(plan.requiresAgent).toBe(false);
  expect(plan.outputs.has('general')).toBe(false);
});
test('S1: gap coverage is per field and complementary descriptions need no refinement', () => {
  const plan = planFillDeclarations({ kinds, plugins: [plugin('index', [output('File', ['title'])]), general()] });
  expect(plan.outputs.get('general')?.get('File')).toEqual(['description']);
  expect(plan.requiresAgent).toBe(true);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('index', [output('File', ['title'])]), general()], agentSelected: false })).toThrow(/general.*requested an agent/);
});
test('S2: declaration gaps never depend on runtime omission or a value quality judgement', () => {
  const covered = planFillDeclarations({ kinds, plugins: [plugin('index'), general()] });
  expect(covered.producers('File', 'description')).toEqual(['index']);
  expect(covered.lastProducer('File', 'description')).toBe('index');
});
test('declared refinement metadata remains available without selecting execution outputs', () => {
  const plan = planFillDeclarations({ kinds, plugins: [
    plugin('base'),
    plugin('middle', [output('File', '*', { refines: ['base'] })]),
    plugin('last', [output('File', ['description'], { refines: ['middle'] })]),
  ], selectedKinds: [] });
  expect(plan.declaredProducers('File', 'description')).toEqual(['base', 'middle', 'last']);
  expect(plan.declaredProducers('File', 'title')).toEqual(['base', 'middle']);
  expect(plan.order).toEqual([]);
  expect([...plan.outputs]).toEqual([]);
  expect(plan.producers('File', 'description')).toEqual([]);
  expect(plan.lastProducer('File', 'description')).toBeUndefined();
});
test('S3: a plugin\'s reads orders its turn after the producers of the kinds it reads, with no derives-from', () => {
  const catalogue = [kind('Document'), kind('Policy'), kind('Summary', ['description'])];
  const declarations = [plugin('document', [output('Document')]), plugin('policy', [output('Policy')]), plugin('summary', [output('Summary', '*', { reads: ['Policy'] })])];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: declarations, selectedKinds: ['Summary'] });
  expect(plan.selectedKinds).toEqual(['Policy', 'Summary']);
  expect(plan.order).toEqual(['policy', 'summary']);
  expect(plan.unitPredecessors('summary', 'Summary')).toEqual([{ plugin: 'policy', kind: 'Policy' }]);
  expect([...plan.outputs.get('summary')!.keys()]).toEqual(['Summary']);
});

test('a plugin that reads a kind its output does not rest on still runs after that kind\'s producers', () => {
  const catalogue = [
    { ...kind('code.file', ['repository', 'path']), line: 4 },
    { ...kind('code.package', ['ecosystem', 'name']), line: 9 },
  ];
  const declarations = [plugin('disk', [output('code.file')]), plugin('imports', [output('code.package', '*', { reads: ['code.file'] })])];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: declarations, selectedKinds: ['code.package'] });
  expect(plan.selectedKinds).toEqual(['code.file', 'code.package']);
  expect(plan.order).toEqual(['disk', 'imports']);
  expect(plan.unitPredecessors('imports', 'code.package')).toEqual([{ plugin: 'disk', kind: 'code.file' }]);
});
test('S4: each output validates and selects only its own dependencies', () => {
  const catalogue = [kind('X'), kind('Y'), kind('A', ['description'], ['X']), kind('B', ['description'], ['Y'])];
  const multi = plugin('multi', [output('A', '*', { reads: ['X'] }), output('B', '*', { reads: ['Y'] })]);
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [plugin('x', [output('X')]), plugin('y', [output('Y')]), multi], selectedKinds: ['A'] });
  expect(plan.selectedKinds).toEqual(['X', 'A']);
  expect([...plan.outputs.get('multi')!.keys()]).toEqual(['A']);
  expect(plan.unitPredecessors('multi', 'A')).toEqual([{ plugin: 'x', kind: 'X' }]);
  expect(plan.readsFor('multi', 'A')).toEqual(['X']);
  const hidden = plugin('multi', [output('A', '*', { reads: ['Y'] }), output('B', '*', { reads: ['Y'] })]);
  const read = planFillDeclarations({ kinds: catalogue, plugins: [hidden, plugin('x', [output('X')]), plugin('y', [output('Y')])], selectedKinds: ['A'] });
  expect(read.selectedKinds).toEqual(['X', 'Y', 'A']);
  expect(read.order).toEqual(['x', 'y', 'multi']);
  expect(read.unitPredecessors('multi', 'A')).toEqual([{ plugin: 'x', kind: 'X' }, { plugin: 'y', kind: 'Y' }]);
});
test('S5: a later refiner does not silently remove a required latest dependency', () => {
  const catalogue = [kind('Source'), kind('Summary', ['description'], ['Source'])];
  const basePlugin = plugin('base', [output('Source'), output('Summary', '*', { reads: ['Source'] })]);
  const refine = plugin('review', [output('Source', '*', { refines: ['base'] }), output('Summary', '*', { refines: ['base'] })]);
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [basePlugin, refine], selectedKinds: ['Summary'] });
  expect(plan.unitPredecessors('base', 'Summary')).toContainEqual({ plugin: 'review', kind: 'Source' });
});
test('S5: explicit earlier reads pin only the named version; genuine refinement cycles still refuse', () => {
  const catalogue = [kind('Source'), kind('Summary', ['description'], ['Source'])];
  const basePlugin = plugin('base', [output('Source'), output('Summary', '*', { reads: [{ kind: 'Source', version: 'earlier', producer: 'base' }] })]);
  const downstream = plugin('review', [output('Source', '*', { refines: ['base'] })]);
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [basePlugin, downstream], selectedKinds: ['Summary'] });
  expect(plan.unitPredecessors('base', 'Summary')).toEqual([{ plugin: 'base', kind: 'Source' }]);
  expect(plan.unitPredecessors('base', 'Summary')).not.toContainEqual({ plugin: 'review', kind: 'Source' });
  expect(plan.readsFor('base', 'Summary')).toEqual([{ kind: 'Source', version: 'earlier', producer: 'base' }]);
  const left = plugin('left', [output('File', ['title'], { refines: ['right'] }), output('File', ['description'])]);
  const right = plugin('right', [output('File', ['title']), output('File', ['description'], { refines: ['left'] })]);
  expect(() => planFillDeclarations({ kinds, plugins: [left, right] })).toThrow(/fill declarations form a cycle/);
});
test('S6: authored input is satisfied by an ordinary enabled producer, not an origin exception', () => {
  const catalogue = [kind('Requirement'), kind('Problem', ['description'], ['Requirement'])];
  const check = plugin('check', [output('Problem', '*', { reads: ['Requirement'] })]);
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: [check], selectedKinds: ['Problem'] })).toThrow(/Requirement has no enabled producer/);
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [plugin('authored', [output('Requirement')]), check], selectedKinds: ['Problem'], agentSelected: false });
  expect(plan.order).toEqual(['authored', 'check']);
  expect(plan.requiresAgent).toBe(false);
});
test('S7: selected outputs exclude unselected outputs from multi-output invocation planning', () => {
  const catalogue = [kind('File'), kind('Summary', ['description'], ['File'])];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [plugin('multi', [output('File'), output('Summary')])], selectedKinds: ['File'] });
  expect([...plan.outputs.get('multi')!.keys()]).toEqual(['File']);
  expect(plan.producers('Summary', 'description')).toEqual([]);
});
test('explicit kind agent configuration compiles ordinary scoped refinement and retains gaps', () => {
  const catalogue = [kind('File'), kind('Other')];
  const manifest = manifestOf(catalogue, [plugin('index'), general()]);
  const configured = manifest.kinds.get('File')!;
  const withConfig = { ...manifest, kinds: new Map([...manifest.kinds, ['File', { ...configured, agent: { plugin: 'general', fields: ['description'], refines: ['index'] } }]]) } as KindsManifest;
  const plan = planManifestFill(withConfig, '/product', ['File']);
  expect(plan.outputs.get('general')?.get('File')).toEqual(['description']);
  expect(plan.lastProducer('File', 'description')).toBe('general');
  expect(plan.outputs.get('general')?.has('Other')).toBe(false);
  expect(() => planManifestFill({ ...withConfig, kinds: new Map([['File', { ...configured, agent: { plugin: 'general', fields: ['description'] } }]]) } as KindsManifest, '/product', ['File'])).toThrow(/without a refinement relation/);
});
test('refinement authorization does not leak across kinds or fields', () => {
  const catalogue = [kind('File'), kind('Other')];
  const left = plugin('a', [output('File'), output('Other')]);
  const right = plugin('b', [output('File', ['title'], { refines: ['a'] }), output('File', ['description']), output('Other')]);
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: [left, right] })).toThrow(/both produce File.description without a refinement relation/);
});
test('earlier self reads require explicit refinement and an enabled named producer', () => {
  const earlier = { kind: 'File', version: 'earlier', producer: 'base' };
  const refiner = plugin('review', [output('File', '*', { reads: [earlier], refines: ['base'] })]);
  expect(planFillDeclarations({ kinds, plugins: [plugin('base'), refiner] }).unitPredecessors('review', 'File')).toEqual([{ plugin: 'base', kind: 'File' }]);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('base'), plugin('review', [output('File', '*', { reads: [earlier] })])] })).toThrow(/without a refinement relation/);
});
test('unknown references, empty outputs and invalid concurrency retain source locations', () => {
  expect(() => plugin('check', [])).toThrow(/\/product\/check\/plugin.json:\d+: plugin check declares no output/);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a', [output('Missing')])] })).toThrow(/Missing is not a declared kind/);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a', [output('File', ['missing'])])] })).toThrow(/names undeclared field File.missing/);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a', [output('File', '*', { refines: ['disabled'] })])] })).toThrow(/refines unknown or disabled plugin disabled/);
  expect(() => parsePluginManifest('{\n "name":"a",\n "concurrency":0\n}', '/product/a/plugin.json')).toThrow('/product/a/plugin.json:3: plugin a concurrency must be a positive integer');
  expect(() => parsePluginManifest(JSON.stringify({ ...base, name: 'a', produces: [output('File')], reads: [] }), '/product/a/plugin.json')).toThrow();
});
test('manifest planning does not turn available agent capability into executable coverage', () => {
  const manifest = manifestOf([kind('File')], [general()]);
  const plan = planManifestFill(manifest, '/product', ['File'], false);
  expect(plan.order).toEqual([]);
  expect(plan.requiresAgent).toBe(false);
  expect([...plan.outputs]).toEqual([]);
  expect(plan.producers('File', 'description')).toEqual([]);
  expect(plan.unproducedKinds).toEqual([{
    kind: 'File', outcome: 'abstained',
    reason: 'kind File has no configured producer; configure an ordinary producer or kind.agent',
  }]);
});
test('manifest planning requires a selected adapter for explicitly configured agent output', () => {
  const manifest = manifestOf([kind('File')], [general()]);
  const file = manifest.kinds.get('File')!;
  const configured = { ...manifest, kinds: new Map([['File', { ...file, agent: { plugin: 'general', fields: '*' } }]]) } as KindsManifest;
  expect(() => planManifestFill(configured, '/product', ['File'], false)).toThrow(/general.*requested an agent/);
  const plan = planManifestFill(configured, '/product', ['File'], true);
  expect(plan.order).toEqual(['general']);
  expect(plan.requiresAgent).toBe(true);
  expect(plan.outputs.get('general')?.get('File')).toEqual(['title', 'description']);
  expect(plan.unproducedKinds).toEqual([]);
});
test('manifest planning reports missing prerequisites without scheduling their dependants', () => {
  const catalogue = [kind('File'), kind('Summary', ['description'], ['File']), kind('Independent')];
  const manifest = manifestOf(catalogue, [plugin('summary', [output('Summary', '*', { reads: ['File'] })]), plugin('independent', [output('Independent')]), general()]);
  const plan = planManifestFill(manifest, '/product', ['Summary', 'Independent'], false);
  expect(plan.order).toEqual(['independent']);
  expect(plan.selectedKinds).toEqual(['Independent']);
  expect(plan.outputs.has('summary')).toBe(false);
  expect(plan.producers('File', 'description')).toEqual([]);
  expect(plan.producers('Summary', 'description')).toEqual([]);
  expect(plan.requiresAgent).toBe(false);
  expect(plan.unproducedKinds).toEqual([
    { kind: 'File', outcome: 'abstained', reason: 'kind File has no configured producer; configure an ordinary producer or kind.agent' },
    { kind: 'Summary', outcome: 'abstained', reason: 'required prerequisite has no configured producer for Summary' },
  ]);
});
