import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { GraphContract } from '../src/graph/contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';

test('repeated schema clients reuse the declared contract stamp', async () => {
  let generated = 0;
  const contract: GraphContract = { vertex: [{ name: 'fixture', table: 'unused', capability: 'fixture', key: [], fields: [
    { name: 'title', type: 'text', get nullable() { generated++; return false; } },
  ] }], edge: [], dictionary: [] };
  const owner = { transaction: async (_kind: unknown, work: (tx: unknown) => Promise<unknown>) =>
    await work({ query: async () => ({ rows: [] }) }) } as unknown as DatabaseOwner;
  await expect(createOneGraphSchema(owner, contract)).rejects.toThrow('has no prepared one-graph schema');
  const first = generated;
  expect(first).toBeGreaterThan(0);
  await expect(createOneGraphSchema(owner, contract)).rejects.toThrow('has no prepared one-graph schema');
  expect(generated).toBe(first);
});
