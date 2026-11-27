import { expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { SYSTEM_CONTRACT, withSystemContract } from '../src/graph/system-contract.js';
import { AuthoredRefusal, authoredEntity } from '../src/graph/authored.js';
import { createTestDatabaseOwner } from './test-database.js';
import { installSystemSources } from '../src/graph/system-installation.js';
import { bindGraphProducer } from '../src/graph/producer-binding.js';
import { GraphRefusal } from '../src/graph/validation.js';

function read(body: string) {
  return parseKinds(`kinds:
  person:
${body}`, '/tmp/overlay/madarch/catalog.yaml', '/tmp/overlay');
}

test('authored schema omits inherited system fields', async () => {
  const manifest = read(`    extends: system:person
    origin: person
`);
  const contract = withSystemContract(graphContractOf(manifest));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const schema = await owner.transaction('snapshot', async tx => authoredEntity(tx, manifest, 'product', undefined, 'schema', 'person'));
    expect(schema.fields).toEqual([]);
    const { person } = await installSystemSources(owner, contract);
    const binding = bindGraphProducer(owner, contract, { principal: person.principal, vertices: { person: [] }, edges: {} });
    const made = await owner.transaction('write', async tx => authoredEntity(tx, manifest, 'product', binding, 'create', 'person', { values: {} }));
    expect(made.entity!.values).toHaveProperty('installation');
    try {
      await owner.transaction('write', async tx => authoredEntity(tx, manifest, 'product', binding, 'create', 'person', { values: { installation: 'forged' } }));
      throw new Error('accepted inherited system input');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoredRefusal);
      const refusal = (error as AuthoredRefusal).refusal;
      expect(refusal).toBeInstanceOf(GraphRefusal);
      expect(refusal!.toJSON()).toMatchObject({ code: 'SCHEMA_INVALID', path: '/values/installation', actual: 'forged' });
    }
  } finally { await owner.close(); }
});

test('explicit system extension retains base identity, extra fields and edges', () => {
  const manifest = read(`    extends: system:person
    fields:
      - { name: email, type: text, nullable: true, producers: [agent] }
    relations:
      - { type: knows, to: 'person:{label}' }
`);
  expect(manifest.findings).toEqual([]);
  expect(manifest.kinds.get('person')?.systemBase).toEqual(SYSTEM_CONTRACT.vertex.find(kind => kind.name === 'person'));
  expect(manifest.kinds.get('person')?.relations).toMatchObject([{ type: 'knows', to: 'person:{label}' }]);
  const person = withSystemContract(graphContractOf(manifest)).vertex.find((kind) => kind.name === 'person')!;
  const base = SYSTEM_CONTRACT.vertex.find((kind) => kind.name === 'person')!;
  expect(person.key).toEqual([]);
  expect(person.capability).toBe('system');
  expect(person.fields.filter((field) => field.name !== 'email')).toEqual([...base.fields]);
  expect(person.fields.find((field) => field.name === 'email')).toMatchObject({ name: 'email', nullable: true });
});

test('extensions reject mismatched bases, natural keys, inherited fields and required additions at their source', () => {
  for (const body of [
    '    extends: system:role\n',
    '    extends: system:missing\n',
    '    extends: system:person\n    key: [label]\n',
    '    extends: system:person\n    capability: agent\n',
    '    extends: system:person\n    source: document\n',
    '    extends: system:person\n    fields: [{ name: label, type: text, nullable: true, producers: [agent] }]\n',
    '    extends: system:person\n    fields: [{ name: email, type: text, producers: [agent] }]\n',
    '    extends: system:person\n    fields: wrong\n',
  ]) {
    const manifest = read(body);
    expect(manifest.kinds.has('person')).toBe(false);
    expect(manifest.findings.length).toBeGreaterThan(0);
    const diagnostics = manifest.findings.filter((finding) => finding.message.startsWith('kind "person":'));
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const finding of diagnostics) {
      expect(finding.file).toBe('/tmp/overlay/madarch/catalog.yaml');
      expect(finding.line).toBeGreaterThanOrEqual(3);
    }
  }
});

test('reserved names without explicit inheritance fail at admission', () => {
  const ordinary = read('    source: graph\n');
  expect(ordinary.kinds.get('person')?.systemBase).toBeUndefined();
  expect(ordinary.kinds.has('person')).toBe(false);
  expect(ordinary.findings).toContainEqual(expect.objectContaining({ file: '/tmp/overlay/madarch/catalog.yaml', line: 2, message: expect.stringContaining('extends: system:person') }));
});

test('every inherited identity and constraint control is refused at its declaration', () => {
  for (const control of ['key', 'key-edges', 'identity', 'uid', 'evidence', 'checks', 'indexes', 'capability']) {
    const manifest = read(`    extends: system:person
    ${control}: {}
`);
    expect(manifest.kinds.has('person')).toBe(false);
    expect(manifest.findings).toContainEqual(expect.objectContaining({
      file: '/tmp/overlay/madarch/catalog.yaml', line: 4,
      message: expect.stringContaining(`"${control}" cannot replace an inherited system contract`),
    }));
  }
});
