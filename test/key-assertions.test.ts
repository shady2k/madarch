import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { ensureVertex, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { loadAssertions } from '../src/graph/assertion-read.js';

const contract: GraphContract = {
  vertex: [{ name: 'keyed', table: generatedTableName('keyed', 'vertex'), key: ['name'],
    fields: [{ name: 'name', type: 'text' }, { name: 'amount', type: 'integer' }], capability: 'fixture' },
    { name: 'compound-key', table: generatedTableName('compound-key', 'vertex'), key: ['ordinal', 'label'],
      fields: [{ name: 'ordinal', type: 'integer' }, { name: 'label', type: 'json', schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.test/key-label/v1', type: 'string',
      } }], capability: 'fixture' }],
  edge: [{ name: 'key-link', from: ['keyed'], to: ['keyed'], fields: [{ name: 'amount', type: 'integer' }],
    repeats: false, cardinality: { from: 'many', to: 'many' }, capability: 'fixture',
    labels: { en: { out: 'link', in: 'linked' }, ru: { out: 'связь', in: 'связанные' } } }], dictionary: [],
};

test('scalar keys are immutable asserted facts with complete source history, not identity-only values', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const { prepareGraphSchema } = await import('../src/adapters/schemas/graph.js');
    await prepareGraphSchema(owner, contract);
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'compound-key', key: { ordinal: 3, label: 'scalar JSON label' },
        producer: 'fixture', producerVersion: '1' }], removals: [] });
    });
    const compound = await owner.transaction('snapshot', tx => loadAssertions(tx, 'vertex', 'compound-key', ['ordinal', 'label']));
    expect(compound.map(row => [row.property, row.value])).toEqual([['ordinal', 3], ['label', 'scalar JSON label']]);
    const first = await owner.transaction('write', async tx => {
      const binding = await bindTestWriteCapability(tx, contract);
      const written = await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'keyed', key: { name: 'same' },
        validFrom: '2020-01-01T00:00:00Z', producer: 'fixture', producerVersion: '1' }], removals: [] });
      expect(written).toBe(2);
      const subject = (await tx.query<{ id: string }>(`SELECT n.id::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='keyed'`)).rows[0]!;
      return { binding, id: subject.id };
    });
    const secondSource = '019a0000-0000-7000-8000-000000000088';
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract, secondSource);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'keyed', key: { name: 'same' },
        producer: 'fixture', producerVersion: '1' }], removals: [] });
    });
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'keyed', subjectId: first.id, property: 'amount', operation: 'assert', value: 7 });
      await expect(writeAssertion(tx, contract, { sort: 'vertex', kind: 'keyed', subjectId: first.id, property: 'missing', operation: 'assert', value: 7 })).rejects.toThrow('UNKNOWN_PROPERTY');
      await publishGraphDrafts(tx, contract, { vertices: [], edges: [{ kind: 'key-link', from: { kind: 'keyed', key: { name: 'same' } },
        to: { kind: 'keyed', key: { name: 'same' } }, values: { amount: 8 }, producer: 'fixture', producerVersion: '1' }], removals: [] });
    });
    expect((await owner.transaction('snapshot', tx => loadAssertions(tx, 'vertex', 'keyed', ['amount']))).map(row => row.value)).toEqual([7]);
    expect((await owner.transaction('snapshot', tx => loadAssertions(tx, 'edge', 'key-link', ['amount']))).map(row => row.value)).toEqual([8]);
    const history = await owner.transaction('snapshot', tx => loadAssertions(tx, 'vertex', 'keyed', ['name']));
    expect(history).toHaveLength(2);
    expect(history.map(row => row.value)).toEqual(['same', 'same']);
    expect(history.map(row => row.source)).toEqual([first.binding.sourceUid, secondSource]);
    expect(history[0]!.author).toBe(first.binding.principalUid);
    expect(history[0]!.validFrom).toBe('2020-01-01T00:00:00.000Z');
    expect(history[0]!.operationUid).toBe(first.binding.operationUid);
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      for (const input of [{ operation: 'assert' as const, value: 'different' }, { operation: 'retract' as const },
        { operation: 'assert' as const, value: 'same', language: 'en' }]) {
        await expect(writeAssertion(tx, contract, { sort: 'vertex', kind: 'keyed', subjectId: first.id, property: 'name', ...input })).rejects.toThrow('IMMUTABLE_KEY');
      }
    });
    await expect(owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await ensureVertex(tx, contract, { kind: 'keyed', key: { name: 'unasserted' } });
    })).rejects.toThrow('IMMUTABLE_KEY');
    for (const [kind, property] of [['keyed', 'name'], ['compound-key', 'label']]) await expect(owner.transaction('write', async tx => {
      const assertionId = (await tx.query<{ id: string }>(`SELECT v.assertion_id::text AS id FROM "${assertionValueTableName(kind!, 'vertex', property!)}" v LIMIT 1`)).rows[0]!.id;
      const { newUid } = await import('../src/graph/uid.js');
      const assertion = await tx.query<{ id: string }>(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id)
        SELECT entity_id,$2::uuid,key,identity_scope,context_id FROM node WHERE id=$1 RETURNING id::text`, [assertionId, newUid()]);
      const id = assertion.rows[0]!.id;
      await tx.query(`INSERT INTO assertion(assertion_id,property,language,context_id,valid_from,valid_to,operation)
        SELECT $2::bigint,property,language,context_id,valid_from,valid_to,operation FROM assertion WHERE assertion_id=$1`, [assertionId,id]);
      const subjectEdge = await tx.query<{ id: string }>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
        SELECT $3::uuid,e.entity_id,$2::bigint,e.to_node,e.discriminator,e.context_id FROM assertion_vertex_subject s
        JOIN edge e ON e.id=s.subject_edge_id WHERE s.assertion_id=$1 RETURNING id::text`, [assertionId,id,newUid()]);
      await tx.query(`INSERT INTO assertion_vertex_subject(assertion_id,subject_edge_id) VALUES($1,$2)`,[id,subjectEdge.rows[0]!.id]);
      for (const relation of ['source','author','operation']) await tx.query(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
        SELECT $4::uuid,e.entity_id,$2::bigint,e.to_node,e.discriminator,e.context_id FROM edge e JOIN entity k ON k.id=e.entity_id
        WHERE e.from_node=$1 AND k.name=$3`,[assertionId,id,`system.assertion-${relation}`,newUid()]);
      await tx.query(`INSERT INTO "${assertionValueTableName(kind!,'vertex',property!)}"(assertion_id,value) VALUES($1,$2)`,[id,kind==='compound-key'?JSON.stringify('contradiction'):'contradiction']);
    })).rejects.toThrow('IMMUTABLE_KEY');
    expect(await owner.transaction('snapshot', async tx => (await tx.query(`SELECT * FROM "${assertionValueTableName('keyed', 'vertex', 'name')}"`)).rows)).toHaveLength(2);
  } finally { await owner.close(); }
}, 60_000);


test('0039.28: schema changes regenerate the static key validation plan', async () => {
  const { generateContractStatements } = await import('../src/adapters/schemas/graph-definition.js');
  const before = generateContractStatements(contract).statements.find(sql => sql.includes('FUNCTION graph_checks_pass()'))!;
  const expanded: GraphContract = { ...contract, vertex: [...contract.vertex, {
    name: 'unrelated-key', table: generatedTableName('unrelated-key', 'vertex'), key: ['code'],
    fields: [{ name: 'code', type: 'bigint' }], capability: 'fixture',
  }] };
  const after = generateContractStatements(expanded).statements.find(sql => sql.includes('FUNCTION graph_checks_pass()'))!;
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    const { prepareGraphSchema } = await import('../src/adapters/schemas/graph.js');
    await prepareGraphSchema(owner, expanded);
    for (const [kind, key] of [['keyed', { name: 'unconfirmed' }], ['unrelated-key', { code: 7 }]] as const) {
      await expect(owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, expanded);
        await ensureVertex(tx, expanded, { kind, key });
      })).rejects.toThrow('IMMUTABLE_KEY');
    }
  } finally { await owner.close(); }
  expect(before).not.toMatch(/\bEXECUTE\b/i);
  expect(after).not.toMatch(/\bEXECUTE\b/i);
}, 60_000);
