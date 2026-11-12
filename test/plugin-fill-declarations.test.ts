import { expect, test } from 'bun:test';
import { parsePluginManifest } from '../src/plugin/closure.js';
import { planFillDeclarations, planManifestFill } from '../src/plugin/fill-declarations.js';
import { fillRequirementOf } from '../src/knowledge/fill-requirements.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';

const base = { version: '1.0.0', entry: 'index.ts', runtime: { name: 'bun', version: Bun.version } };
function plugin(name: string, extra: Record<string, unknown> = {}) {
  const text = JSON.stringify({ ...base, name, produces: [{ kind: 'note', fields: '*' }], reads: [], ...extra }, null, 2);
  return { manifest: parsePluginManifest(text, `/product/${name}/plugin.json`), file: `/product/${name}/plugin.json`, text };
}
const kinds = [{ name: 'note', fields: ['title', 'body'], file: '/product/kinds.yaml', line: 4 }];
test('plugin declarations refuse output-free plugins at the source line', () => {
  expect(() => plugin('check', { produces: [] })).toThrow(/\/product\/check\/plugin.json:\d+: plugin check declares no output/);
});
test('declarations order readers and refiners without plugin categories', () => {
  const a = plugin('writer');
  const b = plugin('reader', { produces: [{ kind: 'note', fields: ['body'] }], reads: ['note'], refines: ['writer'] });
  const plan = planFillDeclarations({ kinds, plugins: [b, a], selectedKinds: ['note'] });
  expect(plan.order).toEqual(['writer', 'reader']);
  expect(plan.predecessors.get('reader')).toEqual(['writer']);
  expect(plan.lastProducer('note', 'body')).toBe('reader');
});
test('read ordering does not excuse unordered overlapping writers', () => {
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a'), plugin('b', { reads: ['note'] })] })).toThrow(/both produce note.title without a refinement relation.*other declaration \/product\/b\/plugin.json:\d+/);
});
test('wildcards expand from enabled producers and catalogue only', () => {
  const plan = planFillDeclarations({ kinds, plugins: [plugin('specific'), plugin('general', { produces: [{ kind: '*', fields: '*' }], refines: ['*'] })] });
  expect(plan.order).toEqual(['specific', 'general']);
  expect(plan.lastProducer('note', 'title')).toBe('general');
});
test('cycles, missing outputs, invalid fields and disabled refiners refuse before execution', () => {
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a', { refines: ['b'] }), plugin('b', { refines: ['a'] })] })).toThrow(/fill declarations form a cycle/);
  expect(() => planFillDeclarations({ kinds, plugins: [], selectedKinds: ['note'] })).toThrow('/product/kinds.yaml:4: selected kind note has no enabled producer');
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a', { produces: [{ kind: 'note', fields: ['missing'] }] })] })).toThrow(/names undeclared field note.missing/);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a', { refines: ['disabled'] })] })).toThrow(/refines unknown or disabled plugin disabled/);
});
test('invalid concurrency points at the actual JSON property', () => {
  expect(() => parsePluginManifest('{\n "name":"a",\n "concurrency":0\n}', '/product/a/plugin.json')).toThrow('/product/a/plugin.json:3: plugin a concurrency must be a positive integer');
});

test('read cycles and unknown inputs retain their declaration locations', () => {
  const extraKinds = [...kinds, { name: 'other', fields: ['title'], file: '/product/kinds.yaml', line: 9 }];
  expect(() => planFillDeclarations({ kinds: extraKinds, plugins: [plugin('a', { reads: ['other'] }), plugin('b', { produces: [{ kind: 'other', fields: '*' }], reads: ['note'] })] })).toThrow(/fill declarations form a cycle/);
  expect(() => planFillDeclarations({ kinds, plugins: [plugin('a', { reads: ['missing'] })] })).toThrow(/\/product\/a\/plugin.json:\d+: missing is not a declared kind/);
});
test('agent requirement applies only to selected plugins that request the host agent', () => {
  const agent = plugin('agent', { agent: { prompt: 'Fill.', roots: ['product'] } });
  expect(() => planFillDeclarations({ kinds, plugins: [agent], selectedKinds: ['note'], agentSelected: false })).toThrow(/requested an agent but none is selected/);
  expect(planFillDeclarations({ kinds, plugins: [agent], selectedKinds: [], agentSelected: false }).order).toEqual([]);
  expect(planFillDeclarations({ kinds, plugins: [plugin('plain')], agentSelected: false }).order).toEqual(['plain']);
});

test('readers consume the pre-refinement snapshot, not their own downstream refiners', () => {
  const catalogue = [...kinds, { name: 'source', fields: ['text'], file: '/product/kinds.yaml', line: 8 }];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [
    plugin('reader', { reads: ['source'] }),
    plugin('review', { produces: [{ kind: '*', fields: '*' }], refines: ['reader'] }),
  ], selectedKinds: ['note'] });
  expect(plan.order).toEqual(['reader', 'review']);
  expect(plan.predecessors.get('reader')).toEqual([]);
});

test('derived-kind units wait for prerequisite units from other producers', () => {
  const catalogue = [...kinds, { name: 'summary', fields: ['body'], derivesFrom: ['note'], file: '/product/kinds.yaml', line: 8 }];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [
    plugin('source'), plugin('summary', { produces: [{ kind: 'summary', fields: '*' }] }),
    plugin('review', { produces: [{ kind: '*', fields: '*' }], refines: ['*'] }),
  ] });
  expect(plan.unitPredecessors('summary', 'summary')).toEqual([{ plugin: 'source', kind: 'note' }]);
  expect(plan.unitPredecessors('review', 'summary')).toEqual(expect.arrayContaining([{ plugin: 'review', kind: 'note' }]));
});

test('kind prerequisite edges combined with plugin reads still refuse genuine unit cycles', () => {
  const catalogue = [...kinds, { name: 'summary', fields: ['body'], derivesFrom: ['note'], file: '/product/kinds.yaml', line: 8 }];
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: [
    plugin('source', { reads: ['summary'] }),
    plugin('summary', { produces: [{ kind: 'summary', fields: '*' }] }),
  ] })).toThrow(/fill declarations form a cycle/);
});

test('whole manifest fills validate declared plugin outputs, not unrelated native kinds', () => {
  const producer = plugin('writer');
  const manifest = {
    file: '/product/madarch/kinds.yaml',
    kinds: new Map([
      ['note', { name: 'note', fields: [{ name: 'title' }, { name: 'body' }], line: 4 }],
      ['native', { name: 'native', fields: [], line: 8 }],
    ]),
    plugins: new Map([['writer', { id: 'writer', declaration: producer.manifest, declarationFile: producer.file, declarationText: producer.text }]]),
  } as unknown as KindsManifest;
  expect(planManifestFill(manifest, '/product').order).toEqual(['writer']);
  expect(() => planManifestFill(manifest, '/product', ['native'])).toThrow(/selected kind native has no enabled producer/);
});

// Admission and preview use the same enabled-plugin plan, not kind origins.
test('agentless deterministic plans expose no agent requirement; selected agent requests retain source advice', () => {
  const plain = plugin('plain');
  const agent = plugin('writer', { agent: { prompt: 'Fill.', roots: ['product'] }, produces: [{ kind: 'other', fields: '*' }] });
  const catalogue = [...kinds, { name: 'other', fields: ['title'], file: '/product/kinds.yaml', line: 9 }];
  const plan = planFillDeclarations({ kinds: catalogue, plugins: [plain, agent], selectedKinds: ['note'], agentSelected: false });
  expect(plan.requiresAgent).toBe(false);
  expect(planFillDeclarations({ kinds: catalogue, plugins: [plain, agent], selectedKinds: ['other'] }).requiresAgent).toBe(true);
  expect(() => planFillDeclarations({ kinds: catalogue, plugins: [plain, agent], selectedKinds: ['other'], agentSelected: false }))
    .toThrow(/\/product\/writer\/plugin.json:\d+: plugin writer requested an agent but none is selected; choose --agent or select one in the wiki/);
});

test('catalogue requirement follows prerequisites and wildcard plugins, not unrelated enabled outputs', () => {
  const source = plugin('source', { agent: { prompt: 'Fill.', roots: ['product'] } });
  const summary = plugin('summary', { produces: [{ kind: 'summary', fields: '*' }] });
  const plain = plugin('plain', { produces: [{ kind: 'plain', fields: '*' }] });
  const declarations = [source, summary, plain];
  const manifest = {
    file: '/product/madarch/kinds.yaml',
    kinds: new Map([
      ['note', { name: 'note', fields: [{ name: 'title' }, { name: 'body' }], line: 4 }],
      ['summary', { name: 'summary', fields: [{ name: 'body' }], derivesFrom: ['note'], line: 8 }],
      ['plain', { name: 'plain', fields: [{ name: 'title' }], line: 12 }],
    ]),
    plugins: new Map(declarations.map((item) => [item.manifest.name, { id: item.manifest.name, declaration: item.manifest, declarationFile: item.file, declarationText: item.text }])),
  } as unknown as KindsManifest;
  expect(fillRequirementOf(manifest, '/product', ['plain'])).toEqual({});
  expect(fillRequirementOf(manifest, '/product', ['summary'])).toEqual({ requiresAgent: true });
  expect(fillRequirementOf(manifest, '/product', ['plain', 'summary'])).toEqual({ requiresAgent: true });
  const general = plugin('general', { agent: { prompt: 'Fill.', roots: ['product'] }, produces: [{ kind: '*', fields: '*' }], refines: ['*'] });
  const withGeneral = { ...manifest, plugins: new Map<string, unknown>([...manifest.plugins!, ['general', { id: 'general', declaration: general.manifest, declarationFile: general.file, declarationText: general.text }]]) } as unknown as KindsManifest;
  expect(fillRequirementOf(withGeneral, '/product', ['plain'])).toEqual({ requiresAgent: true });
  expect(fillRequirementOf({ ...manifest, plugins: new Map() }, '/product', ['plain'])).toEqual({ fillPlanRefusal: '/product/madarch/kinds.yaml:12: selected kind plain has no enabled producer; enable its producer' });
});
