import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { initializeOperationScope, operationReceipt } from '../src/graph/operation-host.js';
import { bindWriteCapability, publishGraphDrafts } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';
import type { OuterTransaction } from '../src/history-types.js';

test('receipt reads one or several stored fields with one subject lookup and assertion read', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    const installed = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'receipt-batch'));
    const unitUid = newUid();
    await owner.transaction('write', async tx => {
      await initializeOperationScope(tx, installed.contract, installed.binding, newUid(), unitUid);
      bindWriteCapability(tx, installed.binding);
      await publishGraphDrafts(tx, installed.contract, { vertices: [
        { kind: 'system.operation', uid: installed.binding.operationUid, key: {}, values: { key: 'one', canonical_request: 'request' }, producer: installed.binding.sourceUid, producerVersion: '1' },
      ], removals: [], edges: [{ kind: 'system.operation-unit', from: { kind: 'system.operation', uid: installed.binding.operationUid, key: {} }, to: { kind: 'system.unit', uid: unitUid, key: {} }, producer: installed.binding.sourceUid, producerVersion: '1' }] });
    });
    const read = async () => await owner.transaction('snapshot', async tx => {
      const statements: string[] = [];
      const measured: OuterTransaction = { ...tx, query: async (sql, values) => { statements.push(sql); return await tx.query(sql, values); } };
      const receipt = await operationReceipt(measured, installed.contract, unitUid, 'one');
      return { receipt, queries: statements.length, nodes: statements.filter(sql => sql === 'SELECT id::text AS id FROM node WHERE uid=$1::uuid').length };
    });
    const one = await read();
    await owner.transaction('write', async tx => {
      bindWriteCapability(tx, installed.binding);
      await publishGraphDrafts(tx, installed.contract, { vertices: [{ kind: 'system.operation', uid: installed.binding.operationUid, key: {}, values: { digest: 'digest', result: '{"ok":true}' }, producer: installed.binding.sourceUid, producerVersion: '1' }], removals: [] });
    });
    const several = await read();
    expect(one.receipt?.canonicalRequest).toBe('request');
    expect(one.receipt?.digest).toBeUndefined();
    expect(one.receipt?.result).toBeUndefined();
    expect(several.receipt).toEqual({ canonicalRequest: 'request', digest: 'digest', result: '{"ok":true}' });
    console.log(JSON.stringify({ receiptQueries: [one.queries, several.queries], subjectLookups: [one.nodes, several.nodes] }));
    expect(several.queries).toBe(one.queries);
    expect(several.nodes).toBe(1);
    expect(several.queries).toBe(4);
  } finally { await owner.close(); }
});
