import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { withSystemContract, SYSTEM_CONTRACT } from '../src/graph/system-contract.js';
import { installSystemSources, personBinding } from '../src/graph/system-installation.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { activateGraphProducer } from '../src/graph/producer-binding.js';
import { readKindAssertions } from '../src/graph/records.js';
import { AuthoredRefusal, authoredEntity } from '../src/graph/authored.js';
import { GraphRefusal } from '../src/graph/validation.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';

test('a person may state extension fields without authority over the installed system fields', async () => {
  const base = SYSTEM_CONTRACT.vertex.find((kind) => kind.name === 'person')!;
  const contract = withSystemContract({ vertex: [{ ...base, fields: [...base.fields, { name: 'display_name', type: 'text', nullable: true }] }], edge: [], dictionary: [] });
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const { person } = await installSystemSources(owner, contract);
    const binding = await personBinding(owner, contract);
    const draft = { kind: 'person', key: {}, uid: person.uid, producer: binding.producer, producerVersion: binding.version };
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, binding);
      await publishGraphDrafts(tx, contract, { vertices: [{ ...draft, values: { display_name: 'Local participant' } }], removals: [] });
    });
    await expect(owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, binding);
      await publishGraphDrafts(tx, contract, { vertices: [{ ...draft, values: { installation: 'forged' } }], removals: [] });
    })).rejects.toThrow('FORBIDDEN_SOURCE');
    const held = await owner.transaction('snapshot', async tx => await readKindAssertions(tx, 'vertex', 'person', ['installation', 'display_name'], { contract }));
    expect(held).toHaveLength(1);
    expect(held[0]!.values.display_name).toBe('Local participant');
    expect(held[0]!.values.installation).not.toBe('forged');
  } finally { await owner.close(); }
});

test('person-authored system extensions do not require or overwrite inherited installation fields', async () => {
  const manifest = parseKinds(`kinds:
  person:
    extends: system:person
    origin: person
    fields:
      - name: name
        type: text
        nullable: true
        binding:
          agent: A descriptive name, not an identity key.
`, 'madarch/catalog.yaml', '/tmp');
  expect(manifest.findings).toEqual([]);
  const contract = graphContractOf(manifest);
  const owner = await createTestDatabaseOwner({ graphContract: withSystemContract(contract) });
  try {
    const binding = await personBinding(owner, contract);
    const made = await owner.transaction('write', async (tx) => await authoredEntity(tx, manifest, 'product', binding, 'create', 'person', { values: { name: 'Participant' } }));
    expect(made.entity!.values.name).toBe('Participant');
    expect(made.entity!.values).toHaveProperty('installation');
    const schema = await owner.transaction('snapshot', async tx => authoredEntity(tx, manifest, 'product', undefined, 'schema', 'person'));
    expect(schema.fields.map(field => field.name)).toEqual(['name']);
    const read = await owner.transaction('snapshot', async tx => authoredEntity(tx, manifest, 'product', undefined, 'read', 'person', { uid: made.entity!.uid }));
    expect(read.fields.map(field => field.name)).toContain('installation');
    expect(read.entity!.values).toHaveProperty('installation');
    for (const action of ['create', 'edit'] as const) {
      try {
        await owner.transaction('write', async tx => authoredEntity(tx, manifest, 'product', binding, action, 'person', { uid: made.entity!.uid, values: { installation: 'forged' } }));
        throw new Error('accepted inherited system input');
      } catch (error) {
        expect(error).toBeInstanceOf(AuthoredRefusal);
        const refusal = (error as AuthoredRefusal).refusal;
        expect(refusal).toBeInstanceOf(GraphRefusal);
        expect(refusal!.toJSON()).toMatchObject({ code: 'SCHEMA_INVALID', path: '/values/installation', actual: 'forged' });
      }
    }
  } finally { await owner.close(); }
});
