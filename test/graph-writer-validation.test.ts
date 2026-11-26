import { describe, expect, test } from 'bun:test';
import { bindWriteCapability, publishGraphDrafts } from '../src/graph/write.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { graphContractVersion } from '../src/graph/contract.js';
import { fits, GraphRefusal, validateFields } from '../src/graph/validation.js';
import type { FieldContract, GraphContract, VertexDraft } from '../src/graph/contract.js';
import type { SqlExecutor } from '../src/sql-driver.js';

const contract: GraphContract = {
  vertex: [{ name: 'sample', table: 'sample_values', key: ['name'], capability: 'fixture', fields: [
    { name: 'name', type: 'text' }, { name: 'title', type: 'text' },
  ] }],
  edge: [{ name: 'relates', table: 'relates_values', from: ['sample'], to: ['sample'], repeats: false,
    cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'relates to', in: 'related from' }, ru: { out: 'связан с', in: 'связан из' } },
    fields: [{ name: 'weight', type: 'integer' }], capability: 'fixture' }],
  dictionary: [],
};

function draft(values: Record<string, unknown>): VertexDraft {
  return { kind: 'sample', key: { name: 'one' }, values, producer: 'agent:scripted', producerVersion: '1' };
}

function noIO(): { executor: SqlExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: SqlExecutor = { query: async sql => { calls.push(sql); throw new Error('invalid answer reached SQL'); } };
  bindWriteCapability(executor, {
    sourceUid: '019a0000-0000-7000-8000-000000000002', principalUid: '019a0000-0000-7000-8000-000000000002',
    operationUid: '019a0000-0000-7000-8000-000000000003', productUid: '019a0000-0000-7000-8000-000000000004',
    context: 1, scope: 'fixture', contractVersion: graphContractVersion(withAssertionContract(contract)),
    permissions: [{ kind: 'sample', properties: ['*'], assert: true, retractOwn: true }, { kind: 'relates', properties: ['*'], assert: true, retractOwn: true }],
  });
  return { calls, executor };
}

async function refused(action: () => Promise<unknown>, path: string, expected: string, actual: unknown): Promise<void> {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GraphRefusal);
  expect((caught as GraphRefusal).toJSON()).toEqual({ code: 'SCHEMA_INVALID', path, expected, actual, retryable: false });
}

describe('0039 item 7: the writer checks agent answers before any SQL', () => {
  test('the fill answer cannot bypass field types', async () => {
    const { executor, calls } = noIO();
    await refused(() => publishGraphDrafts(executor, contract, { vertices: [draft({ title: 17 })], removals: [] }), '/values/title', 'text', 17);
    expect(calls).toEqual([]);
  });

  test('an invalid later draft refuses the entire answer before any identity is declared', async () => {
    const { executor, calls } = noIO();
    await refused(() => publishGraphDrafts(executor, contract, { vertices: [draft({ title: 'valid' }), draft({ title: false })], removals: [] }), '/values/title', 'text', false);
    expect(calls).toEqual([]);
  });

  test('identity key fields are checked before SQL', async () => {
    const { executor, calls } = noIO();
    await refused(() => publishGraphDrafts(executor, contract, { vertices: [{ ...draft({ title: 'valid' }), key: { name: [] as unknown as import('../src/graph/contract.js').KeyValueDraft } }], removals: [] }), '/values/name', 'text', []);
    expect(calls).toEqual([]);
  });

  test('edge attributes are checked before SQL', async () => {
    const { executor, calls } = noIO();
    await refused(() => publishGraphDrafts(executor, contract, {
      vertices: [], removals: [], edges: [{ kind: 'relates', from: { kind: 'sample', key: { name: 'one' } }, to: { kind: 'sample', key: { name: 'two' } }, values: { weight: '3' }, producer: 'fixture', producerVersion: '1' }],
    }), '/values/weight', 'integer', '3');
    expect(calls).toEqual([]);
  });

  test('unknown fields are refused with an RFC 6901 path', () => {
    let caught: unknown;
    try { validateFields([], { 'a/b~c': 7 }, '/values'); } catch (error) { caught = error; }
    expect((caught as GraphRefusal).toJSON()).toEqual({ code: 'SCHEMA_INVALID', path: '/values/a~1b~0c', expected: 'declared field ()', actual: 7, retryable: false });
  });
});

describe('the same field type predicate at doors and writer', () => {
  const cases: [FieldContract['type'], unknown, boolean][] = [
    ['text', 'text', true], ['text', 3, false],
    ['integer', -2147483648, true], ['integer', 2147483647, true], ['integer', 2147483648, false], ['integer', 1.5, false],
    ['bigint', '-9223372036854775808', true], ['bigint', '9223372036854775807', true], ['bigint', '9223372036854775808', false], ['bigint', '-', false], ['bigint', '1.0', false],
    ['boolean', true, true], ['boolean', 'false', false],
    ['timestamp', '2026-11-15T12:00:00Z', true], ['timestamp', 'not a date', false],
    ['json', { values: [true, null, 2] }, true], ['json', undefined, false], ['json', { value: undefined }, false], ['json', NaN, false],
  ];
  for (const [type, value, valid] of cases) test(`${type}: ${JSON.stringify(value)}`, () => {
    expect(fits({ name: 'value', type }, value)).toBe(valid);
  });
  test('null requires an explicitly nullable field', () => {
    expect(fits({ name: 'value', type: 'text' }, null)).toBe(false);
    expect(fits({ name: 'value', type: 'text', nullable: true }, null)).toBe(true);
  });
});
