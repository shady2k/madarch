import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { withSystemContract, SYSTEM_CONTRACT } from '../src/graph/system-contract.js';
import { installSystemSources, personBinding } from '../src/graph/system-installation.js';
import { publishOpinion } from '../src/graph/write.js';
import { authoredEntity } from '../src/graph/authored.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';

test('a person may state extension fields without authority over the installed system fields', async () => {
  const base = SYSTEM_CONTRACT.vertex.find((kind) => kind.name === 'person')!;
  const contract = withSystemContract({ vertex: [{ ...base, fields: [...base.fields, { name: 'display_name', type: 'text', nullable: true }] }], edge: [], dictionary: [] });
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const { person } = await installSystemSources(owner, contract);
    const binding = await personBinding(owner, contract);
    const node = await owner.run(async (tx) => await tx.query<{ id: string }>('SELECT id::text AS id FROM node WHERE uid = $1::uuid', [person.uid]));
    const draft = { kind: 'person', nodeId: node.rows[0]!.id, producer: binding.producer, producerVersion: binding.version };
    await owner.transaction('write', async (tx) => {
      expect(await publishOpinion(tx, contract, { ...draft, selectedFields: ['display_name'], values: { display_name: 'Local participant' } }, 1, undefined, binding)).toBe(true);
      await expect(publishOpinion(tx, contract, { ...draft, selectedFields: ['installation'], values: { installation: 'forged' } }, 1, undefined, binding)).rejects.toThrow('property');
    });
    const held = await owner.run(async (tx) => await tx.query<{ installation: string }>(`SELECT installation FROM "${base.table}" WHERE state = 'open' AND installation IS NOT NULL`));
    expect(held.rows).toHaveLength(1);
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
    await expect(owner.transaction('write', async (tx) => await authoredEntity(tx, manifest, 'product', binding, 'edit', 'person', { uid: made.entity!.uid, values: { installation: 'forged' } }))).rejects.toThrow('not declared');
  } finally { await owner.close(); }
});
