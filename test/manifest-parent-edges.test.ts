import { expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { manifestContractOf } from '../src/fill/stages/plugin-contract.js';
import { Value } from 'typebox/value';
import { PluginContractDeclaration, PluginEntityRef } from '../src/plugin/protocol.js';

const labels = { en: { out: 'belongs to', in: 'contains' }, ru: { out: 'принадлежит', in: 'содержит' } };
function declaration() {
  return { kinds: { parent: { source: 'graph', fields: [{ name: 'name', type: 'text', producers: ['disk'] }], key: ['name'] }, child: { source: 'graph', fields: [{ name: 'path', type: 'text', producers: ['disk'] }], key: ['path'], 'key-edges': [{ role: 'parent', edge: 'belongs', side: 'from' }] } }, edges: [{ name: 'belongs', role: 'containment', direction: 'out', from: ['child'], to: ['parent'], cardinality: { from: { min: 1, max: 1 }, to: { min: 0, max: null } }, 'on-parent-delete': 'restrict', labels }] };
}
function parse(root: unknown) { return parseKinds({ root, at: () => 7 }, '/product/madarch/catalog.yaml', '/product'); }

test('0039 items 1, 2, 28: key edges and bilingual cardinality survive contract generation', () => {
  const manifest = parse(declaration());
  expect(manifest.findings).toEqual([]);
  const contract = manifestContractOf(manifest);
  expect(contract.vertex.find((kind) => kind.name === 'child')?.keyEdges).toEqual([{ role: 'parent', edge: 'belongs', direction: 'from', onDelete: 'restrict' }]);
  expect(contract.edge[0]?.cardinality).toEqual({ from: 'many', to: 'one' });
  expect(contract.edge[0]?.labels).toEqual(labels);
});

test('0039 item 1: scalar reference declarations are refused, not converted', () => {
  const root = declaration();
  Object.assign(root.kinds.child.fields[0]!, { reference: 'parent' });
  expect(parse(root).findings.some((finding) => finding.message.includes('reference'))).toBe(true);
});

test('0039 item 28: deletion policy and required cardinality are mandatory', () => {
  const root = declaration();
  delete (root.edges[0] as Record<string, unknown>)['on-parent-delete'];
  expect(parse(root).findings.some((finding) => finding.message.includes('on-parent-delete'))).toBe(true);
  const optional = declaration(); optional.edges[0]!.cardinality.from.min = 0;
  expect(parse(optional).findings.some((finding) => finding.message.includes('exactly one parent'))).toBe(true);
});

test('0039 item 28: key-edge DAG rejects a parent cycle', () => {
  const root = declaration();
  Object.assign(root.kinds.parent, { 'key-edges': [{ role: 'child', edge: 'reverse', side: 'from' }] });
  root.edges.push({ name: 'reverse', role: 'containment', direction: 'out', from: ['parent'], to: ['child'], cardinality: { from: { min: 1, max: 1 }, to: { min: 0, max: null } }, 'on-parent-delete': 'restrict', labels });
  expect(parse(root).findings.some((finding) => finding.message.includes('key-edge cycle'))).toBe(true);
});

test('0039 item 1: edges require both directional languages and cardinality', () => {
  for (const field of ['labels', 'cardinality']) {
    const root = declaration(); delete (root.edges[0] as Record<string, unknown>)[field];
    expect(parse(root).findings.some((finding) => finding.message.includes(field))).toBe(true);
  }
});

test('0039 item 28: wire keys are scalar and parent addresses are separate recursive roles', () => {
  expect(Value.Check(PluginEntityRef, { kind: 'child', key: { path: 'x' }, keyEdges: { parent: { kind: 'parent', key: { name: 'p' } } } })).toBe(true);
  expect(Value.Check(PluginEntityRef, { kind: 'child', key: { parent: { kind: 'parent', key: { name: 'p' } } } })).toBe(false);
  expect(Value.Check(PluginContractDeclaration, { vertices: [], edges: [{ kind: 'bad', from: 'child', to: 'parent' }] })).toBe(false);
});

test('0039 item 1: declared endpoints must exist and edge names are unique', () => {
  const missing = declaration(); missing.edges[0]!.to = ['absent'];
  expect(parse(missing).findings.some((finding) => finding.message.includes('missing kind'))).toBe(true);
  const repeated = declaration(); repeated.edges.push(repeated.edges[0]!);
  expect(parse(repeated).findings.some((finding) => finding.message.includes('kind names are unique'))).toBe(true);
});

test('0039 item 28: identity fields and key roles cannot repeat', () => {
  const duplicate = declaration(); duplicate.kinds.child.key.push('path');
  expect(parse(duplicate).findings.some((finding) => finding.message.includes('ordered and unique'))).toBe(true);
  const roles = declaration(); roles.kinds.child['key-edges'].push(roles.kinds.child['key-edges'][0]!);
  expect(parse(roles).findings.some((finding) => finding.message.includes('roles are unique'))).toBe(true);
  const missing = declaration(); missing.kinds.child['key-edges'][0]!.edge = 'absent';
  expect(parse(missing).findings.some((finding) => finding.message.includes('missing edge'))).toBe(true);
});

test('edge metadata has one strict bilingual labels shape with no aliases', () => {
  for (const labels of [
    { en: { out: 'owns', in: 'owned by' } },
    { en: { out: 'owns', in: 'owned by', extra: 'no' }, ru: { out: 'владеет', in: 'владелец' } },
    { en: { forward: 'owns', inverse: 'owned by' }, ru: { out: 'владеет', in: 'владелец' } },
    { en: { out: '', in: 'owned by' }, ru: { out: 'владеет', in: 'владелец' } },
    { en: { out: 'owns', in: 'owned by' }, ru: { out: 'владеет', in: 'владелец' }, fr: { out: 'a', in: 'b' } },
  ]) {
    const root = declaration(); Object.assign(root.edges[0]!, { labels });
    expect(parse(root).findings.some((finding) => finding.message.includes('words'))).toBe(true);
    expect(parse(root).edges?.has('belongs') ?? false).toBe(false);
  }
  const alias = declaration(); Object.assign(alias.edges[0]!, { words: labels });
  expect(parse(alias).findings.some((finding) => finding.message.includes('not a field of an edge'))).toBe(true);
});

test('wire refuses parents aliases while supporting recursive keyEdges', () => {
  expect(Value.Check(PluginEntityRef, { kind: 'child', key: { path: 'x' }, parents: {} })).toBe(false);
  const contract = { vertices: [], edges: [{ kind: 'belongs', from: 'child', to: 'parent', cardinality: { from: 'many', to: 'one' }, labels }] };
  expect(Value.Check(PluginContractDeclaration, contract)).toBe(true);
  expect(Value.Check(PluginContractDeclaration, { ...contract, edges: [{ ...contract.edges[0], words: labels }] })).toBe(false);
});

test('federated identity declares an immutable contract and canonical shared-root scope', () => {
  const root = declaration();
  const uid = '12345678-1234-5123-8123-123456789abc';
  Object.assign(root.kinds.parent, { 'contract-uid': uid, identity: { namespace: uid, origin: ['name'] } });
  Object.assign(root.edges[0]!, { 'contract-uid': uid });
  const manifest = parse(root);
  expect(manifest.findings).toEqual([]);
  expect(manifestContractOf(manifest).vertex.find((kind) => kind.name === 'parent')).toMatchObject({ contractUid: uid, identity: { namespace: uid, origin: ['name'] } });
  expect(manifestContractOf(manifest).edge[0]?.contractUid).toBe(uid);
  for (const identity of [{ namespace: 'mutable-url', origin: ['name'] }, { namespace: uid, origin: ['other'] }, { namespace: uid, origin: [] }]) {
    const invalid = declaration(); Object.assign(invalid.kinds.parent, { identity });
    expect(parse(invalid).findings.some((finding) => finding.message.includes('shared root'))).toBe(true);
  }
  const child = declaration(); Object.assign(child.kinds.child, { identity: { namespace: uid, origin: ['path'] } });
  expect(parse(child).findings.some((finding) => finding.message.includes('shared root'))).toBe(true);
});

test('active YAML identity syntax refuses retired key-edge and cardinality aliases', () => {
  const role = declaration(); Object.assign(role.kinds.child['key-edges'][0]!, { direction: 'from', onDelete: 'restrict' });
  expect(parse(role).findings.some((finding) => finding.message.includes('side'))).toBe(true);
  const bounds = declaration(); Object.assign(bounds.edges[0]!, { cardinality: { from: 'many', to: 'one' } });
  expect(parse(bounds).findings.some((finding) => finding.message.includes('cardinality'))).toBe(true);
  const requiredMany = declaration(); requiredMany.edges[0]!.cardinality.to.min = 1;
  expect(parse(requiredMany).edges?.get('belongs')?.cardinality.from).toBe('some');
});

test('immutable contract UUID rejects malformed spelling without a pattern matcher', () => {
  for (const uid of [null, 42, '', '12345678-1234-5123-8123-123456789ab', '12345678-1234-5123-8123-123456789abc0', 'g2345678-1234-5123-8123-123456789abc', '12345678_1234-5123-8123-123456789abc', '12345678-1234_5123-8123-123456789abc', '12345678-1234-5123_8123-123456789abc', '12345678-1234-5123-8123_123456789abc', '12345678-1234-5123-8123-123456789abC']) {
    const root = declaration(); Object.assign(root.kinds.parent, { 'contract-uid': uid });
    expect(parse(root).findings.some((finding) => finding.message.includes('canonical lowercase UUID'))).toBe(true);
  }
});

test('catalogue-only kinds remain graph contracts and edge endpoints without a page', () => {
  const root = declaration();
  Object.assign(root.kinds.parent, { 'template-policy': 'none' });
  root.kinds.parent.source = 'graph';
  Object.assign(root, { groups: { top: { en: 'Top', ru: 'Верх', short: { en: 'Top', ru: 'Верх' } }, sub: { parent: 'top', en: 'Sub', ru: 'Раздел', short: { en: 'Sub', ru: 'Раздел' } } }, catalog: { 'subgroup-kind-bound': 12, attributes: ['status'], 'origin-marks': ['document'], 'extractor-mark': 'extractor', 'template-policies': ['page', 'member', 'none'], relations: {} } });
  for (const [name, kind] of Object.entries(root.kinds)) Object.assign(kind, { id: name, group: 'sub', 'relation-constraints': { out: [], in: [] }, definition: 'A declared entity.', sources: ['https://example.org/standard'], acquisition: ['document'], labels: { en: { one: name, many: name }, ru: { one: name, many: name } }, description: { en: 'A declared entity.', ru: 'Объявленная сущность.' }, 'template-policy': name === 'parent' ? 'none' : 'page' });
  const manifest = parse(root);
  expect(manifest.findings).toEqual([]);
  expect(manifest.kinds.get('parent')).toMatchObject({ source: 'graph', templatePolicy: 'none' });
  expect(manifestContractOf(manifest).vertex.some((kind) => kind.name === 'parent')).toBe(true);
  expect(manifest.edges?.get('belongs')?.to).toEqual(['parent']);
});

test('JSON fields require Draft 2020-12 schemas and retain the local value-type registry', () => {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', items: { type: 'string' } };
  const root = declaration();
  Object.assign(root.kinds.parent.fields[0]!, { type: 'json', schema });
  Object.assign(root, { 'value-types': {strings:{storage:'json',schema:{ ...schema, $id: 'urn:example:strings:v1' }}} });
  const manifest = parse(root);
  expect(manifest.findings).toEqual([]);
  expect(manifestContractOf(manifest).vertex.find((kind) => kind.name === 'parent')?.fields[0]?.schema).toEqual(schema);
  expect(manifestContractOf(manifest).valueTypes).toEqual({strings:{storage:'json',schema:{ ...schema, $id: 'urn:example:strings:v1' }}});
  for (const schema of [undefined, {}, { $schema: 'older-dialect' }]) {
    const invalid = declaration(); Object.assign(invalid.kinds.parent.fields[0]!, { type: 'json', schema });
    expect(parse(invalid).findings.some((finding) => finding.message.includes('Draft 2020-12'))).toBe(true);
  }
  const scalar = declaration(); Object.assign(scalar.kinds.parent.fields[0]!, { schema });
  expect(manifestContractOf(parse(scalar)).vertex.find(kind => kind.name === 'parent')?.fields[0]?.schema).toEqual(schema);
});

test('semantic bindings explicitly resolve fields and endpoint roles, never kind-name inference', () => {
  const root = declaration();
  const binding = { kind: 'child', fields: { statement: 'path' }, edges: { parent: { kind: 'belongs', direction: 'from' } }, values: { statement: { pending: 'open' } } };
  Object.assign(root, { 'semantic-bindings': { 'example-role': binding } });
  const parsed = parse(root);
  expect(parsed.findings).toEqual([]);
  expect(parsed.semanticBindings?.get('example-role')).toMatchObject({ ...binding, line: 7 });
  for (const replacement of [{ kind: 'missing' }, { fields: { statement: 'missing' } }, { edges: { parent: { kind: 'belongs', direction: 'to' } } }, { values: { missing: { open: 'open' } } }]) {
    Object.assign(root, { 'semantic-bindings': { 'example-role': { ...binding, ...replacement } } });
    expect(parse(root).findings.some((finding) => finding.message.includes('semantic binding'))).toBe(true);
  }
});

test('protected manifest graph endpoints come from the canonical contract registry', () => {
  const root = declaration();
  root.edges.push({ ...root.edges[0]!, name: 'describes', from: ['child'], to: ['manifest.kind'] });
  expect(parse(root).findings).toEqual([]);
  root.edges[root.edges.length - 1]!.to = ['source'];
  expect(parse(root).findings).toEqual([]);
  root.edges[root.edges.length - 1]!.to = ['manifest.unknown'];
  expect(parse(root).findings.some((finding) => finding.message.includes('manifest.unknown'))).toBe(true);
});

test('semantic edge fields bind only declared scalar edge properties', () => {
  const root = declaration();
  Object.assign(root.edges[0]!, { fields: [{ name: 'position', type: 'integer' }] });
  const edge = { kind: 'belongs', direction: 'from', fields: { order: 'position' } };
  Object.assign(root, { 'semantic-bindings': { 'example-file': { kind: 'child', fields: { path: 'path' }, edges: { parent: edge } } } });
  expect(parse(root).semanticBindings?.get('example-file')?.edges?.['parent']?.fields).toEqual({ order: 'position' });
  edge.fields.order = 'missing';
  expect(parse(root).findings.some((finding) => finding.message.includes('not declared by edge'))).toBe(true);
});

test('immutable evidence kinds declare their digest identity and content fields explicitly', () => {
  const root = declaration();
  Object.assign(root.kinds.parent, { evidence: { immutable: true, digestField: 'name', contentField: 'name', digestAlgorithm: 'sha256' } });
  const parsed = parse(root);
  expect(parsed.findings).toEqual([]);
  expect(manifestContractOf(parsed).vertex.find((kind) => kind.name === 'parent')?.evidence).toEqual({ immutable: true, digestField: 'name', contentField: 'name', digestAlgorithm: 'sha256' });
  for (const evidence of [{ immutable: false }, { immutable: true, digestField: 'missing' }, { immutable: true, contentField: 'missing' }, { immutable: true, contentField: 'name', digestField: 'name' }, { immutable: true, digestAlgorithm: 'sha256' }]) {
    Object.assign(root.kinds.parent, { evidence });
    expect(parse(root).findings.some((finding) => finding.message.includes('evidence') || finding.message.includes('Field'))).toBe(true);
  }
});

test('known engine semantic roles reject unknown scalar and edge slots without restricting custom roles', () => {
  const root = declaration();
  Object.assign(root, { 'semantic-bindings': { repository: { kind: 'parent', fields: { name: 'name' } } } });
  expect(parse(root).findings).toEqual([]);
  Object.assign(root, { 'semantic-bindings': { repository: { kind: 'parent', fields: { inventedSlot: 'name' } } } });
  expect(parse(root).findings.some((finding) => finding.message.includes('not a scalar slot'))).toBe(true);
  Object.assign(root, { 'semantic-bindings': { repository: { kind: 'parent', fields: { name: 'name' }, edges: { inventedEdge: { kind: 'belongs', direction: 'to' } } } } });
  expect(parse(root).findings.some((finding) => finding.message.includes('not an edge slot'))).toBe(true);
});
