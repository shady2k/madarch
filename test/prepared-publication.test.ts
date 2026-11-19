/** Publication preparation keeps immutable contracts separate from live capabilities (0039 items 7,26). */
import { expect, test } from 'bun:test';
import type { SqlExecutor } from '../src/sql-driver.js';
import { generatedTableName, graphContractVersion, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { bindWriteCapability, publishGraphDrafts, type WriteCapability } from '../src/graph/write.js';

function fixture(): { contract: GraphContract; binding: WriteCapability } {
  const contract: GraphContract = {
    vertex: [{ name: 'fixture.item', table: generatedTableName('fixture.item', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' }],
    edge: [], dictionary: [],
  };
  const uid = '019a0000-0000-7000-8000-000000000002';
  return { contract, binding: { sourceUid: uid, principalUid: uid, operationUid: uid, productUid: uid, scope: uid, context: 1,
    contractVersion: graphContractVersion(withAssertionContract(contract)), permissions: [{ kind: 'fixture.item', properties: ['*'], assert: true, retractOwn: true }] } };
}
const drafts = { vertices: [{ kind: 'fixture.item', key: { name: 'allowed' }, producer: 'fixture', producerVersion: '1' }], removals: [] };

for (const [name, change, error] of [
  ['permission', { permissions: [] }, 'FORBIDDEN_SOURCE'],
  ['context', { context: 2 }, 'SOURCE_FORBIDDEN'],
  ['contract revision', { contractVersion: 'changed' }, 'CONTRACT_CONFLICT'],
] as const) {
  test(`publication checks a changed ${name} after preparation`, async () => {
    const { contract, binding } = fixture();
    let queries = 0;
    const executor: SqlExecutor = { query: async () => {
      queries++;
      bindWriteCapability(executor, { ...binding, ...change });
      return { rows: [] };
    } };
    bindWriteCapability(executor, binding);
    await expect(publishGraphDrafts(executor, contract, drafts)).rejects.toThrow(error);
    expect(queries).toBe(1);
  });
}

test('publication snapshots nested schemas without freezing the caller contract', async () => {
  const { contract, binding } = fixture();
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string', enum: ['allowed'] };
  const field = contract.vertex[0]!.fields[0]!;
  const declared: GraphContract = { ...contract, vertex: [{ ...contract.vertex[0]!, fields: [{ ...field, schema }] }] };
  let queries = 0;
  const executor: SqlExecutor = { query: async () => {
    queries++;
    if (queries === 1) {
      schema.enum[0] = 'changed';
      return { rows: [] };
    }
    throw new Error('reached identity storage after validating the prepared schema');
  } };
  bindWriteCapability(executor, { ...binding, contractVersion: graphContractVersion(withAssertionContract(declared)) });
  await expect(publishGraphDrafts(executor, declared, drafts)).rejects.toThrow('reached identity storage');
  expect(queries).toBe(2);
  expect(schema.enum).toEqual(['changed']);
  expect(Object.isFrozen(schema)).toBe(false);
  expect(Object.isFrozen(schema.enum)).toBe(false);
});
