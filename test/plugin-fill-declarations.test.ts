import { expect, test } from 'bun:test';
import { parsePluginManifest } from '../src/plugin/closure.js';
import { planFillDeclarations, planManifestFill } from '../src/plugin/fill-declarations.js';
import { createPluginTurnStage, planPluginTurns, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import { fillTargets } from '../src/knowledge/fill-targets.js';

const base = { version: '1.0.0', entry: 'index.ts', runtime: { name: 'bun', version: Bun.version } };
function plugin(name: string, produces: unknown[] = [{ kind: 'File', fields: '*' }], agent = false) {
  const text = JSON.stringify({ ...base, name, produces, ...(agent ? { agent: { prompt: 'Fill.', roots: ['product'], catalogue: true } } : {}) }, null, 2);
  return { manifest: parsePluginManifest(text, `/product/${name}/plugin.json`), file: `/product/${name}/plugin.json`, text };
}
const kind = (name: string, fields = ['title', 'description'], derivesFrom: string[] = []) => ({ name, fields, derivesFrom, file: '/product/kinds.yaml', line: name === 'File' ? 4 : 9 });
const kinds = [kind('File')];
const output = (name: string, fields: '*' | string[] = '*', extra = {}) => ({ kind: name, fields, ...extra });
const general = (reads: string[] = []) => plugin('general', [output('*', '*', { coverage: 'gaps', reads })], true);
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

test('person-authored prerequisites remain selected without scheduling a producer', () => {
  const original = manifestOf([kind('Product', ['title']), kind('File', ['title'], ['Product'])], [plugin('index')]);
  const product = original.kinds.get('Product')!;
  const manifest = { ...original, kinds: new Map(original.kinds).set('Product', {
    ...product, fields: product.fields!.map(field => ({ ...field, producers: ['person'] })),
  }) };
  for (const pluginsOnly of [false, true]) {
    const plan = planManifestFill(manifest, '/product', ['File'], false, undefined, pluginsOnly);
    expect(plan.selectedKinds).toEqual(['Product', 'File']);
    expect(plan.order).toEqual(['index']);
    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.selectedKinds).toContain('Product');
    expect([...plan.fieldProducers('Product').keys()]).toEqual(['title']);
  }
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
  expect(plan.agentNeeds).toEqual([{ kind: 'File', fields: ['description'] }]);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('index', [output('File', ['title'])]), general()], agentSelected: false })).toThrow(/leaves File \(description\) to an agent, and none is chosen/);
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
test('a suppressed gap producer does not pull the kinds it reads into the selected set', () => {
  const catalogue = [kind('X'), kind('Y')];
  const declarations = [plugin('main', [output('X')]), plugin('extra', [output('X', '*', { coverage: 'gaps', reads: ['Y'] })])];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: declarations, selectedKinds: ['X'] });
  expect(plan.selectedKinds).toEqual(['X']);
  expect(plan.order).toEqual(['main']);
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
test('manifest planning fills an uncovered kind with the agent, and asks for one before it runs', () => {
  const manifest = manifestOf([kind('File')], [general()]);
  // No chosen agent: the plan stops, naming the kind and every field the agent would fill; the kind never runs unfilled.
  expect(() => planManifestFill(manifest, '/product', ['File'], false)).toThrow(/leaves File \(title, description\) to an agent, and none is chosen/);
  const plan = planManifestFill(manifest, '/product', ['File'], true);
  expect(plan.order).toEqual(['general']);
  expect(plan.requiresAgent).toBe(true);
  expect(plan.agentNeeds).toEqual([{ kind: 'File', fields: ['title', 'description'] }]);
  expect(plan.outputs.get('general')?.get('File')).toEqual(['title', 'description']);
  expect(plan.errors).toEqual([]);
});
test('manifest planning requires a selected adapter for explicitly configured agent output', () => {
  const manifest = manifestOf([kind('File')], [general()]);
  const file = manifest.kinds.get('File')!;
  const configured = { ...manifest, kinds: new Map([['File', { ...file, agent: { plugin: 'general', fields: '*' } }]]) } as KindsManifest;
  expect(() => planManifestFill(configured, '/product', ['File'], false)).toThrow(/leaves File \(title, description\) to an agent, and none is chosen/);
  const plan = planManifestFill(configured, '/product', ['File'], true);
  expect(plan.order).toEqual(['general']);
  expect(plan.requiresAgent).toBe(true);
  expect(plan.outputs.get('general')?.get('File')).toEqual(['title', 'description']);
  expect(plan.errors).toEqual([]);
});
test('manifest planning reports kinds no output at all names, without scheduling their dependants', () => {
  const catalogue = [kind('File'), kind('Summary', ['description'], ['File']), kind('Independent')];
  // A manifest that holds no agent plugin: nothing produces File, so neither File nor what rests on it runs.
  const manifest = manifestOf(catalogue, [plugin('summary', [output('Summary', '*', { reads: ['File'] })]), plugin('independent', [output('Independent')])]);
  const plan = planManifestFill(manifest, '/product', ['Summary', 'Independent'], false);
  expect(plan.order).toEqual(['independent']);
  expect(plan.selectedKinds).toEqual(['Independent']);
  expect(plan.outputs.has('summary')).toBe(false);
  expect(plan.producers('File', 'description')).toEqual([]);
  expect(plan.producers('Summary', 'description')).toEqual([]);
  expect(plan.requiresAgent).toBe(false);
  expect(plan.errors).toEqual([]);
  expect(plan.skipped).toEqual([
    { kind: 'File', fields: ['description', 'title'], reason: 'no producer in the manifest' },
    { kind: 'Summary', fields: [], reason: 'its prerequisite "File" has no producer in the manifest' },
  ]);
});

test('64o5.63: the plan names the plugin of every field and leaves exactly the rest to the agent', () => {
  const catalogue = [kind('File', ['repository', 'path', 'content', 'state_machines'])];
  const disk = plugin('disk', [output('File', ['repository', 'path', 'content'])]);
  const manifest = manifestOf(catalogue, [disk, general(['code.file'])]);
  // The kind alone: the agent's read of code.file is not a declared kind here, so plan the declarations directly.
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [disk, general()], selectedKinds: ['File'], agentSelected: true });
  expect(plan.fieldProducers('File')).toEqual(new Map([
    ['repository', ['disk']],
    ['path', ['disk']],
    ['content', ['disk']],
    ['state_machines', ['general']],
  ]));
  expect(plan.agentNeeds).toEqual([{ kind: 'File', fields: ['state_machines'] }]);
  expect(plan.outputs.get('general')?.get('File')).toEqual(['state_machines']);
  expect(plan.producers('File', 'content')).toEqual(['disk']);
  expect(plan.lastProducer('File', 'content')).toBe('disk');
  expect(manifest.kinds.has('File')).toBe(true);
});

test('64o5.63: a kind every deterministic producer covers runs without an agent', () => {
  const covered = planFillDeclarations({ kinds, plugins: [plugin('index')], selectedKinds: ['File'] });
  expect(covered.order).toEqual(['index']);
  expect(covered.requiresAgent).toBe(false);
  expect(covered.agentNeeds).toEqual([]);
  expect(covered.fieldProducers('File')).toEqual(new Map([['title', ['index']], ['description', ['index']]]));
  // The universal agent capability is not scheduled where no field is left to it.
  const both = planFillDeclarations({ kinds, plugins: [plugin('index'), general()], selectedKinds: ['File'], agentSelected: false });
  expect(both.order).toEqual(['index']);
  expect(both.outputs.has('general')).toBe(false);
  expect(both.requiresAgent).toBe(false);
});

test('64o5.49: lastProducer follows the kind\'s unit order, not the first unit of each plugin', () => {
  const catalogue = [kind('W', ['note']), kind('X', ['title'])];
  // Plugin `a` opens with its W unit, and its X unit refines `b`'s: the deduplicated plugin order would read a, b even
  // though b fills X first and a fills it last.
  const early = plugin('a', [output('W'), output('X', ['title'], { refines: ['b'] })]);
  const other = plugin('b', [output('X', ['title'])]);
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [early, other], selectedKinds: ['W', 'X'], agentSelected: true });
  expect(plan.producers('X', 'title')).toEqual(['b', 'a']);
  expect(plan.lastProducer('X', 'title')).toBe('a');
});

test('64o5.49: an agent-filled kind reads the graph it works from', () => {
  const catalogue = [kind('code.file', ['repository', 'path', 'content']), kind('doc.decision', ['title'])];
  const manifest = manifestOf(catalogue, [plugin('disk', [output('code.file')]), general(['code.file'])]);
  const plan = planManifestFill(manifest, '/product', ['doc.decision'], true);
  expect(plan.readsFor('general', 'doc.decision')).toEqual(['code.file']);
  expect(plan.unitPredecessors('general', 'doc.decision')).toEqual([{ plugin: 'disk', kind: 'code.file' }]);
  // The files the agent reads are the fill's input, so their producer runs first.
  expect(plan.selectedKinds).toEqual(['code.file', 'doc.decision']);
  expect(plan.order).toEqual(['disk', 'general']);
});

test('64o5.49: a request nothing in the manifest can produce fails with the reason', async () => {
  // File has no producer and the manifest holds no agent plugin: Summary's turn can never read it, and neither runs.
  const catalogue = [kind('File'), kind('Summary', ['description'], ['File'])];
  const manifest = manifestOf(catalogue, [plugin('summary', [output('Summary', '*', { reads: ['File'] })])]);
  const wiring = { manifest, productFolder: '/product', targets: { kinds: ['Summary'], requested: ['Summary'] }, locks: new Map([['summary', { id: 'summary', version: '1.0.0', closure: 'a'.repeat(64), path: 'plugins/summary', line: 1 }]]) } as unknown as PluginTurnWiring;
  const stage = createPluginTurnStage(wiring);
  await expect(stage.plan(undefined as never)).rejects.toThrow(/nothing the fill was asked for has a producer: kind "File" \(the fields "description", "title"\) is skipped: no producer in the manifest/);
});

test('64o5.60: a kind configuring a missing agent plugin is an error naming its fields and the plugin', () => {
  const manifest = manifestOf([kind('File')], []);
  const file = manifest.kinds.get('File')!;
  const configured = { ...manifest, kinds: new Map([['File', { ...file, agent: { plugin: 'agent-fill', fields: '*' } }]]) } as KindsManifest;
  // A manifest read for its declarations alone still refuses the configuration it cannot honour.
  expect(() => planManifestFill(configured, '/product', [])).toThrow(/kind File configures unknown or disabled agent plugin agent-fill/);
  // A fill records that kind's error, naming its fields and the plugin, and plans the other kinds.
  const plan = planManifestFill(configured, '/product', ['File'], true);
  expect(plan.errors).toEqual([{
    kind: 'File', fields: ['description', 'title'], plugin: 'agent-fill',
    message: 'kind "File": the fields "description", "title" have no producer: the manifest declares no plugin "agent-fill"',
  }]);
});


test('a plugins-only plan keeps the agent fields and runs the deterministic producers', () => {
  const manifest = manifestOf([kind('File')], [plugin('index', [output('File', ['title'])]), general()]);
  const full = planManifestFill(manifest, '/product', ['File'], true);
  expect(full.agentNeeds).toEqual([{ kind: 'File', fields: ['description'] }]);
  const only = planManifestFill(manifest, '/product', ['File'], true, undefined, true);
  expect(only.pluginsOnly).toBe(true);
  expect(only.order).toEqual(['index']);
  expect(only.outputs.has('general')).toBe(false);
  expect(only.agentNeeds).toEqual([{ kind: 'File', fields: ['description'] }]);
  expect(only.errors).toEqual([]);
});

/** A KindsManifest whose kind declarations carry real field declarations (bindings included). */
function manifestWithFields(catalogue: readonly { name: string; fields: readonly Record<string, unknown>[]; derivesFrom?: readonly string[] }[], declarations: ReturnType<typeof plugin>[]): KindsManifest {
  return {
    file: '/product/kinds.yaml',
    kinds: new Map(catalogue.map((entry) => [entry.name, { name: entry.name, fields: entry.fields, derivesFrom: entry.derivesFrom ?? [], file: '/product/kinds.yaml', line: 4 }])),
    plugins: new Map(declarations.map((entry) => [entry.manifest.name, { id: entry.manifest.name, declaration: entry.manifest, declarationFile: entry.file, declarationText: entry.text }])),
  } as unknown as KindsManifest;
}

test('review 1: a field no producer fills is an error, never a silent gap', async () => {
  const manifest = manifestWithFields([
    { name: 'File', fields: [{ name: 'title', type: 'text' }, { name: 'body', type: 'text', binding: { kind: 'agent', description: 'What the file says.' } }] },
  ], [plugin('index', [output('File', ['title'])])]);
  const plan = planManifestFill(manifest, '/product', ['File'], true);
  expect(plan.fieldProducers('File').get('body')).toEqual([]);
  // No agent plugin is held: the field is skipped, named, and the kind's own producer still runs.
  expect(plan.errors).toEqual([]);
  expect(plan.skipped).toEqual([{ kind: 'File', fields: ['body'], reason: 'no producer in the manifest' }]);
  const wiring = { manifest, productFolder: '/product', targets: { kinds: ['File'], requested: ['File'] }, locks: new Map([['index', { id: 'index', version: '1.0.0', closure: 'a'.repeat(64), path: 'plugins/index', line: 1 }]]) } as unknown as PluginTurnWiring;
  const planned = await createPluginTurnStage(wiring).plan(undefined as never);
  expect(planned.units.map((unit) => unit.id)).toEqual(['index:File']);
});

test('review 2: target selection does not count an unasked kind\'s agent fallback reads', async () => {
  const catalogue = [
    { name: 'A', fields: [{ name: 'title', type: 'text' }] },
    { name: 'B', fields: [{ name: 'title', type: 'text' }, { name: 'body', type: 'text', binding: { kind: 'agent', description: 'What B says.' } }] },
    { name: 'code.file', fields: [{ name: 'content', type: 'text' }] },
  ];
  const manifest = manifestWithFields(catalogue, [
    plugin('pa', [output('A', '*', { reads: ['B'] })]),
    plugin('pb', [output('B', ['title'])]),
    general(['code.file']),
    plugin('pf', [output('code.file', '*', { reads: ['A'] })]),
  ]);
  // B joins only as A's input: its agent fallback is not planned, so its read of code.file orders nothing.
  const read = fillTargets(manifest, ['A']);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.targets.order).toEqual(['B', 'A']);
  const plan = planManifestFill(manifest, '/product', ['A'], true, ['A']);
  expect(plan.errors).toEqual([]);
  expect(plan.order).toEqual(['pb', 'pa']);
});

test('review 3: with an agent plugin, a kind whose input has no producer is an error, and the other kinds still run', async () => {
  const catalogue = [
    { name: 'Summary', fields: [{ name: 'title', type: 'text', binding: { kind: 'agent', description: 'A title.' } }] },
    { name: 'code.file', fields: [{ name: 'content', type: 'text' }] },
    { name: 'Other', fields: [{ name: 'title', type: 'text' }] },
  ];
  const manifest = manifestWithFields(catalogue, [general(['code.file']), plugin('other', [output('Other')])]);
  // The product holds an agent plugin, so a kind that cannot be filled because its input is unproduced is the plan's
  // error, named before the run: it is never skipped in silence. Only a product without an agent plugin skips.
  const plan = planManifestFill(manifest, '/product', ['Summary', 'Other'], true, ['Summary', 'Other']);
  expect(plan.skipped).toEqual([]);
  expect(plan.errors.map((error) => error.kind).sort()).toEqual(['Summary', 'code.file']);
  expect(plan.errors.find((error) => error.kind === 'Summary')).toEqual({
    kind: 'Summary', fields: [],
    message: 'kind "Summary" cannot be filled: its input "code.file" has no producer in the manifest',
  });
  expect(plan.errors.find((error) => error.kind === 'code.file')?.message).toContain('no producer');
  expect(plan.order).toEqual(['other']);
  expect(plan.outputs.get('other')?.has('Other')).toBe(true);
});

test('review 4: a deterministic plugin\'s read of a kind resting on its output is a cycle, not dropped', () => {
  const catalogue = [kind('A', ['title']), kind('B', ['title'], ['A'])];
  const declarations = [plugin('p', [output('A', '*', { reads: ['B'] })]), plugin('q', [output('B')])];
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: declarations, selectedKinds: ['A'] })).toThrow(/fill declarations form a cycle/);
});

test('the clean-install walk\'s fixture plans nothing: a fieldless kind with no plugins needs no agent', () => {
  // The walk replaces the draft's manifest with one fieldless kind and no plugins before it presses Fill with
  // `agent: null`: nothing is planned, so the press cannot wait for an agent that the machine has no sandbox for.
  const manifest = manifestWithFields([{ name: 'code.file', fields: [] }], []);
  const plan = planManifestFill(manifest, '/product', undefined, false);
  expect(plan.order).toEqual([]);
  expect(plan.errors).toEqual([]);
  expect(plan.agentNeeds).toEqual([]);
  expect(plan.selectedKinds).toEqual(['code.file']);
});

test('an agent chosen fills a pulled-in dependency\'s agent-bound field too: Домены over Файлы with state_machines', () => {
  // The owner's refusal (madarch-64o5.102): selecting Домены pulls in Файлы, whose state_machines only the agent fills.
  // The agent is the filler of last resort for a dependency as much as for the asked kind, so the run starts.
  const manifest = manifestOf([kind('File', ['title', 'state_machines']), kind('Domain', ['title'], ['File'])], [plugin('index', [output('File', ['title']), output('Domain', ['title'])]), general(['File'])]);
  const plan = planManifestFill(manifest, '/product', ['Domain'], true, ['Domain']);
  expect(plan.errors).toEqual([]);
  expect([...plan.selectedKinds]).toContain('Domain');
  // The dependency's agent-bound field is named among the unfilled, not refused and not silently planned.
  expect(plan.skipped).toEqual([{ kind: 'File', fields: ['state_machines'], reason: 'the agent fills it, and this fill does not ask for this kind' }]);
});

test('a page that names its plan\'s kinds does not turn a pulled-in dependency into an asked one', () => {
  // The prepare route passes the plan's kinds (Домены and the Файлы it pulls in); the person asked for Домены only.
  const manifest = manifestOf([kind('File', ['title', 'state_machines']), kind('Domain', ['title'], ['File'])], [plugin('index', [output('File', ['title']), output('Domain', ['title'])]), general(['File'])]);
  const plan = planManifestFill(manifest, '/product', ['Domain', 'File'], true, ['Domain']);
  expect(plan.errors).toEqual([]);
  expect(plan.skipped).toEqual([{ kind: 'File', fields: ['state_machines'], reason: 'the agent fills it, and this fill does not ask for this kind' }]);
});

test('a pulled-in kind still names a field bound to a plugin the manifest lacks', () => {
  // A pull-in must not hide a manifest error: File.body binds to the absent plugin `missing` while the titles are filled.
  const file = { ...kind('File', ['title', 'body']), file: '/product/kinds.yaml', line: 4 };
  const manifest = manifestOf([file, kind('Domain', ['title'], ['File'])], [plugin('index', [output('File', ['title']), output('Domain', ['title'])]), general(['File'])]);
  const bound = manifest.kinds.get('File') as unknown as { fields: { name: string; binding?: { kind: string; plugin?: string } }[] };
  bound.fields = bound.fields.map((field) => field.name === 'body' ? { ...field, binding: { kind: 'plugin', plugin: 'missing' } } : field);
  const plan = planManifestFill(manifest, '/product', ['File', 'Domain'], true, ['Domain']);
  expect(plan.errors.map((error) => error.kind)).toEqual(['File']);
  expect(plan.skipped).toEqual([]);
});

test('support reads depend on the explicit source owner unit without a synthetic support unit', () => {
  const catalogue = [kind('File'), kind('Blob'), kind('Summary')];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [
    plugin('disk', [output('File', '*', { support: { vertices: ['Blob'], edges: [] } })]),
    plugin('summary', [output('Summary', '*', { reads: ['File', 'Blob'] })]),
  ], selectedKinds: ['Summary'] });
  expect(plan.unitPredecessors('summary', 'Summary')).toEqual([{ plugin: 'disk', kind: 'File' }]);
  expect(plan.outputs.get('disk')?.has('Blob')).toBe(false);
  expect(plan.selectedKinds).toContain('File');
  expect(plan.order).toEqual(['disk', 'summary']);
});
test('support owner resolution prefers explicit read source scope and refuses undeclared or ambiguous owners', () => {
  const catalogue = [kind('File'), kind('Import'), kind('Blob'), kind('Summary')];
  const owners = [plugin('disk', [output('File', '*', { support: { vertices: ['Blob'], edges: [] } })]), plugin('imports', [output('Import', '*', { support: { vertices: ['Blob'], edges: [] } })])];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [...owners, plugin('summary', [output('Summary', '*', { reads: ['File', 'Blob'] })])], selectedKinds: ['Summary'] });
  expect(plan.unitPredecessors('summary', 'Summary')).toEqual([{ plugin: 'disk', kind: 'File' }]);
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: [...owners, plugin('summary', [output('Summary', '*', { reads: ['Blob'] })])], selectedKinds: ['Summary'] })).toThrow('support read Blob has ambiguous owner units');
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: [plugin('summary', [output('Summary', '*', { reads: ['Blob'] })])], selectedKinds: ['Summary'] })).toThrow('selected kind Blob has no enabled producer');
});
test('an explicit earlier support producer resolves to its real owner unit and cycles are refused', () => {
  const catalogue = [kind('File'), kind('Import'), kind('Blob'), kind('Summary')];
  const owners = [plugin('disk', [output('File', '*', { support: { vertices: ['Blob'], edges: [] } })]), plugin('imports', [output('Import', '*', { support: { vertices: ['Blob'], edges: [] } })])];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [...owners, plugin('summary', [output('Summary', '*', { reads: [{ kind: 'Blob', version: 'earlier', producer: 'disk' }] })])], selectedKinds: ['Summary'] });
  expect(plan.unitPredecessors('summary', 'Summary')).toEqual([{ plugin: 'disk', kind: 'File' }]);
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: [plugin('disk', [output('File', '*', { reads: ['Summary'], support: { vertices: ['Blob'], edges: [] } })]), plugin('summary', [output('Summary', '*', { reads: ['Blob'] })])], selectedKinds: ['Summary'] })).toThrow('fill declarations form a cycle');
});

test('manifest planning retains explicit support dependencies without agent synthetic blob output', () => {
  const manifest = manifestOf([kind('File'), kind('Blob'), kind('Summary')], [
    plugin('disk', [output('File', '*', { support: { vertices: ['Blob'], edges: [] } })]),
    general(['File', 'Blob']),
  ]);
  const plan = planManifestFill(manifest, '/product', ['Summary', 'Blob'], true);
  expect(plan.errors).toEqual([]);
  expect(plan.unitPredecessors('general', 'Summary')).toEqual([{ plugin: 'disk', kind: 'File' }]);
  expect(plan.outputs.get('general')?.has('Blob')).toBe(false);
});

test('support source reads take priority over other selected owners and otherwise use the selected owner scope', () => {
  const catalogue = [kind('File'), kind('Import'), kind('Blob'), kind('Summary')];
  const owners = [plugin('imports', [output('Import', '*', { support: { vertices: ['Blob'], edges: [] } })]), plugin('disk', [output('File', '*', { support: { vertices: ['Blob'], edges: [] } })])];
  const source = planFillDeclarations({ kinds: catalogue, plugins: [...owners, plugin('summary', [output('Summary', '*', { reads: ['File', 'Blob'] })])], selectedKinds: ['File', 'Import', 'Summary'] });
  expect(source.unitPredecessors('summary', 'Summary')).toEqual([{ plugin: 'disk', kind: 'File' }]);
  const versioned = planFillDeclarations({ kinds: catalogue, plugins: [...owners, plugin('summary', [output('Summary', '*', { reads: [{ kind: 'File', version: 'earlier', producer: 'disk' }, 'Blob'] })])], selectedKinds: ['File', 'Import', 'Summary'] });
  expect(versioned.unitPredecessors('summary', 'Summary')).toEqual([{ plugin: 'disk', kind: 'File' }]);
  const scoped = planFillDeclarations({ kinds: catalogue, plugins: [...owners, plugin('summary', [output('Summary', '*', { reads: ['Blob'] })])], selectedKinds: ['File', 'Summary'] });
  expect(scoped.unitPredecessors('summary', 'Summary')).toEqual([{ plugin: 'disk', kind: 'File' }]);
  try {
    planFillDeclarations({ kinds: catalogue, plugins: [...owners, plugin('summary', [output('Summary', '*', { reads: ['Blob'] })])], selectedKinds: ['Summary'] });
    throw new Error('expected an ambiguous support owner refusal');
  } catch (error) {
    expect((error as { file: string }).file).toBe('/product/summary/plugin.json');
    expect((error as { line: number }).line).toBeGreaterThan(1);
    expect((error as Error).message).toContain('disk:File, imports:Import');
  }
});


test('a forward-filtered agent source read does not leave its support read unscoped', () => {
  const manifest = manifestOf([
    kind('Repository'), kind('File', ['title'], ['Repository']), kind('Directory'), kind('Blob'),
  ], [
    plugin('disk', [
      output('File', '*', { support: { vertices: ['Blob'], edges: [] } }),
      output('Directory', '*', { support: { vertices: ['Blob'], edges: [] } }),
    ]),
    general(['File', 'Blob']),
  ]);
  const plan = planManifestFill(manifest, '/product', ['Repository'], true);
  expect(plan.errors).toEqual([]);
  expect(plan.readsFor('general', 'Repository')).toEqual([]);
  expect(plan.unitPredecessors('general', 'Repository')).toEqual([]);
  expect(plan.selectedKinds).toEqual(['Repository']);
});
