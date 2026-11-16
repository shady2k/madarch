import { expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { MANIFEST_CONTRACT, withManifestContract } from '../src/graph/manifest-contract.js';
import { parse, stringify } from 'yaml';
import { SYSTEM_CONTRACT, withAssertionContract } from '../src/graph/system-contract.js';

// The removed catalogue declaration, restored verbatim to exercise 0039 item 9.
const stageYaml = `id: manifest.workflow-stage
purpose: structure
audience:
- architect
- developer
definition: A workflow stage is one ordered executable step declared by a product
  workflow.
sources:
- https://github.com/shady2k/madarch/blob/main/docs/decisions/0033-one-workflow-by-entity-kinds.md
acquisition:
- document
relation-constraints:
  out:
  - partOf
  in:
  - hasPart
template-policy: none
source: graph
fields:
- name: name
  type: text
  labels:
    en: Name
    ru: Имя
  binding:
    agent: The stage name in the executable workflow declaration.
- name: position
  type: integer
  labels:
    en: Position
    ru: Позиция
  binding:
    agent: The zero-based position of this stage in its workflow declaration.
- name: executor
  type: text
  nullable: true
  binding:
    agent: The executor declared for the stage, such as plugin or agent.
key:
- name
key-edges:
- role: manifest.workflow-stage-workflow
  edge: workflow-stages
  side: to
labels:
  en:
    one: Workflow stage
    many: Workflow stages
  ru:
    one: Стадия процесса
    many: Стадии процесса
description:
  en: An executable stage belongs to one workflow and has an explicit position in
    its sequence. It is distinct from a stage of planned product work.
  ru: Исполняемая стадия принадлежит одному процессу и имеет явное место в его последовательности.
    Это не этап запланированной работы над продуктом.
`;
const stageName = 'manifest.workflow-stage';
const file = '/fixture/madarch/catalog.yaml';
function restored() {
  return { kinds: {
    workflow: { source: 'graph', fields: [{ name: 'name', type: 'text', producers: ['fixture'] }], key: ['name'] },
    [stageName]: parse(stageYaml),
  }, edges: [{ name: 'workflow-stages', from: ['workflow'], to: [stageName],
    cardinality: { from: { min: 0, max: null }, to: { min: 1, max: 1 as number | null } },
    labels: { en: { out: 'Stage', in: 'Referenced by' }, ru: { out: 'Этап', in: 'Указано в' } },
    'on-parent-delete': 'cascade',
  }] };
}

test('manifest inheritance refuses replacement of the restored stage identity and protected edges', () => {
  const manifest = parseKinds(stringify(restored()), file, '/fixture');
  const contract = graphContractOf(manifest);
  // The catalogue checker may refuse the declaration; the join must also protect direct contracts.
  const held = MANIFEST_CONTRACT.vertex.find(one => one.name === stageName)!;
  const replacements = [
    { ...held, key: ['position'] },
    { ...held, keyEdges: [{ role: 'workflow', edge: 'workflow-stages', direction: 'to' as const, onDelete: 'cascade' as const }] },
  ];
  for (const replacement of replacements) {
    expect(() => withManifestContract({ ...contract, vertex: [replacement] })).toThrow('cannot replace protected');
  }
  const edge = MANIFEST_CONTRACT.edge[0]!;
  expect(() => withManifestContract({ ...contract, vertex: [], edge: [{ ...edge, to: ['workflow'] }] })).toThrow('cannot replace protected');
});

test('catalogue refuses protected kind and edge names without explicit system inheritance at their YAML lines', () => {
  const restoredBody = restored();
  // Isolate the name refusal from the independently forbidden required edge.
  restoredBody.edges = [];
  const yaml = stringify(restoredBody);
  const line = yaml.split('\n').findIndex(one => one === `  ${stageName}:`) + 1;
  const manifest = parseKinds(yaml, file, '/fixture');
  expect(manifest.findings).toContainEqual(expect.objectContaining({ file, line, message: expect.stringContaining('extends: system:') }));
  for (const name of ['manifest.workflow-stage-workflow', 'session-agent']) {
    const body = restored();
    delete (body.kinds as Record<string, unknown>)[stageName];
    body.edges[0] = { ...body.edges[0]!, name, to: ['workflow'], cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } } };
    const edgeYaml = stringify(body);
    const edgeLine = edgeYaml.split('\n').findIndex(one => one.includes(`name: ${name}`)) + 1;
    expect(parseKinds(edgeYaml, file, '/fixture').findings).toContainEqual(expect.objectContaining({ file, line: edgeLine, message: expect.stringContaining('extends: system:') }));
  }
});

test('catalogue refuses a required edge on either protected YAML end, including any', () => {
  for (const protectedName of [stageName, 'system.run', 'any']) for (const side of ['from', 'to'] as const) {
    const body = restored();
    delete (body.kinds as Record<string, unknown>)[stageName];
    body.edges[0] = { ...body.edges[0]!, from: side === 'from' ? [protectedName] : ['workflow'], to: side === 'to' ? [protectedName] : ['workflow'],
      cardinality: { from: { min: side === 'from' ? 1 : 0, max: null }, to: { min: side === 'to' ? 1 : 0, max: null } } };
    const yaml = stringify(body);
    const lines = yaml.split('\n');
    const cardAt = lines.findIndex(one => one.includes('cardinality:'));
    const line = lines.findIndex((one, index) => index > cardAt && one.trim() === `${side}:`) + 1;
    const manifest = parseKinds(yaml, file, '/fixture');
    expect(manifest.findings).toContainEqual(expect.objectContaining({ file, line, message: expect.stringContaining('protected') }));
    body.edges[0]!.cardinality[side].min = 0;
    expect(parseKinds(stringify(body), file, '/fixture').findings).toEqual([]);
  }
});

function extension(name: string, fields: unknown[] = [{ name: 'note', type: 'text', nullable: true }]) {
  return { kinds: { [name]: { extends: `system:${name}`, fields: fields.map(field => ({ ...(field as Record<string, unknown>), producers: ['fixture'] })) } } };
}

function edgeExtension(name: string, overlay: Record<string, unknown> = {}) {
  return { kinds: {}, edges: [{ name, extends: `system:${name}`, fields: [{ name: 'note', type: 'text', nullable: true, producers: ['fixture'] }], ...overlay }] };
}

test('nullable manifest vertex extensions preserve inherited fields, identity and producer from YAML through the join', () => {
  for (const base of MANIFEST_CONTRACT.vertex) {
    const manifest = parseKinds(stringify(extension(base.name)), file, '/fixture');
    expect(manifest.findings).toEqual([]);
    const joined = withManifestContract(graphContractOf(manifest));
    expect(joined.vertex.find(one => one.name === base.name)).toEqual({ ...base,
      fields: [...base.fields, { name: 'note', type: 'text', nullable: true }],
    });
  }
});

test('operation extends system:operation remains installable over both system contracts', () => {
  const manifest = parseKinds(stringify(extension('operation')), file, '/fixture');
  expect(manifest.findings).toEqual([]);
  const installed = withAssertionContract(withManifestContract(graphContractOf(manifest)));
  expect(installed.vertex.find(one => one.name === 'operation')).toEqual({ ...SYSTEM_CONTRACT.vertex.find(one => one.name === 'operation')!,
    fields: [{ name: 'label', type: 'text', nullable: true }, { name: 'note', type: 'text', nullable: true }],
  });
});

test('nullable protected edge extensions inherit each manifest and system edge through the shared join', () => {
  for (const base of [...MANIFEST_CONTRACT.edge, ...SYSTEM_CONTRACT.edge, ...withAssertionContract(MANIFEST_CONTRACT).edge.filter(one => one.name === 'system.unit-parent')]) {
    const manifest = parseKinds(stringify(edgeExtension(base.name)), file, '/fixture');
    expect(manifest.findings).toEqual([]);
    const joined = withAssertionContract(withManifestContract(graphContractOf(manifest)));
    expect(joined.edge.find(one => one.name === base.name)).toEqual({ ...base,
      fields: [...base.fields, { name: 'note', type: 'text', nullable: true }],
    });
  }
});

test('protected YAML extensions refuse identity, endpoint and required-field replacements at their source lines', () => {
  const cases = [
    { body: extension(stageName, [{ name: 'note', type: 'text' }]), marker: 'name: note' },
    { body: { kinds: { [stageName]: { ...extension(stageName).kinds[stageName], 'key-edges': [] } } }, marker: 'key-edges:' },
    { body: edgeExtension('manifest.depends-on', { from: ['operation'] }), marker: 'from:' },
    { body: edgeExtension('manifest.depends-on', { repeats: true }), marker: 'repeats:' },
    { body: edgeExtension('manifest.depends-on', { fields: [{ name: 'note', type: 'text' }] }), marker: 'name: note' },
    { body: edgeExtension('manifest.depends-on', { fields: [{ name: 'declaration', type: 'text', nullable: true }] }), marker: 'name: declaration' },
  ];
  for (const { body, marker } of cases) {
    const yaml = stringify(body);
    const line = yaml.split('\n').findIndex(one => one.includes(marker)) + 1;
    expect(parseKinds(yaml, file, '/fixture').findings).toContainEqual(expect.objectContaining({ file, line }));
  }
});

test('shared protected join permits nullable edge fields but refuses direct identity and field changes', () => {
  const base = MANIFEST_CONTRACT.edge[1]!;
  const contract = { vertex: [], dictionary: [], edge: [{ ...base, fields: [...base.fields, { name: 'note', type: 'text' as const, nullable: true }] }] };
  expect(withManifestContract(contract).edge.find(one => one.name === base.name)).toEqual(contract.edge[0]);
  for (const replacement of [
    { ...base, from: ['operation'] }, { ...base, repeats: true }, { ...base, discriminator: 'note' },
    { ...base, fields: [{ name: 'note', type: 'text' as const }] },
    { ...base, fields: [{ name: 'declaration', type: 'integer' as const }] },
  ]) expect(() => withManifestContract({ ...contract, edge: [replacement] })).toThrow();
});
