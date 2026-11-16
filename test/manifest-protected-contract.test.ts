import { expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { MANIFEST_CONTRACT, withManifestContract } from '../src/graph/manifest-contract.js';
import { parse, stringify } from 'yaml';

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
