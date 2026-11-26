import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { ProducerBinding } from '../src/graph/producer-binding.js';
import { executeManualOperation } from '../src/graph/manual-operation.js';

test('interactive writer rejects missing authenticated transport identities before storage access', async () => {
  const owner = { transaction: () => { throw new Error('unauthorized storage access'); } } as unknown as DatabaseOwner;
  for (const kind of ['put-entity', 'put-edge', 'retract'] as const) {
    const operation = { kind, input: {} } as Parameters<typeof executeManualOperation>[2];
    await expect(executeManualOperation(owner, { producer: 'forged', version: '1' }, operation, {} as ProducerBinding)).rejects.toThrow('authenticated operation request identity');
    await expect(executeManualOperation(owner, { producer: 'forged', version: '1', operationId: 'forged' }, operation, {} as ProducerBinding)).rejects.toThrow('host-issued source binding');
  }
});
