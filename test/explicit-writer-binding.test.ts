import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { ProducerBinding } from '../src/graph/producer-binding.js';
import { putEntityOpinion, putEdgeOpinion, retractOpinion } from '../src/graph/graph-writes.js';

test('explicit writer doors reject serialized identities before opening a transaction', async () => {
  const owner = { transaction: () => { throw new Error('unauthorized storage access'); } } as unknown as DatabaseOwner;
  const evidence = [{ type: 'url', url: 'https://example.test', at: '2026-11-13T12:00:00Z' }];
  for (const value of [undefined, { producer: 'agent:trusted', version: '1' }]) {
    const binding = value as unknown as ProducerBinding;
    await expect(putEntityOpinion(owner, binding, { kind: 'x', values: {}, evidence })).rejects.toThrow('host-issued');
    await expect(putEdgeOpinion(owner, binding, { kind: 'x', from: {}, to: {}, evidence })).rejects.toThrow('host-issued');
    await expect(retractOpinion(owner, binding, { entity: { kind: 'x' }, evidence })).rejects.toThrow('host-issued');
  }
});
