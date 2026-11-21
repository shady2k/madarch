import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { initializeOperationScope, resolveOperationScope } from '../src/graph/operation-host.js';
import { newUid } from '../src/graph/uid.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publicationReadSelector } from '../src/graph/publication-contract.js';
import type { OuterTransaction } from '../src/history-types.js';

test('operation scope initialization batches machine and ordinary fields without changing lineage', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    const { binding, contract } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'scope-batch'));
    const measure = async (work: (tx: OuterTransaction) => Promise<unknown>) => await owner.transaction('write', async tx => {
      const statements: string[] = [];
      const measured: OuterTransaction = { ...tx, query: async (sql, values) => { statements.push(sql); return await tx.query(sql, values); } };
      await work(measured);
      return statements.filter(sql => sql === 'SELECT id::text AS id FROM node WHERE uid=$1::uuid').length;
    });
    const runUid = newUid(), unitUid = newUid();
    const init = await measure(tx => initializeOperationScope(tx, contract, binding, runUid, unitUid));
    const resolve = await measure(tx => resolveOperationScope(tx, contract, binding, { runId: 'run', unitId: 'unit', generation: 1, scope: 'kind' }));
    console.log(JSON.stringify({ scopeSubjectLookups: { init, resolve } }));
    await owner.transaction('snapshot', async tx => {
      const selector = await publicationReadSelector(tx, contract);
      const units = await readKindAssertions(tx, 'vertex', 'system.unit', ['state', 'committed_operations', 'last_progress', 'unit_name', 'generation', 'scope'], selector);
      expect(units.find(unit => unit.uid === unitUid)!.values).toMatchObject({ state: 'running', committed_operations: 0, last_progress: 'admitted' });
      expect(units.find(unit => unit.values.unit_name === 'unit')!.values).toMatchObject({ state: 'running', generation: 1, scope: 'kind' });
      const operations = await readKindAssertions(tx, 'vertex', 'system.operation', [], selector);
      expect(operations.map(operation => operation.uid)).toEqual([binding.operationUid]);
    });
    expect(init).toBeLessThanOrEqual(1);
    expect(resolve).toBeLessThanOrEqual(1);
  } finally { await owner.close(); }
});
