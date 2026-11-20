import { expect, test } from 'bun:test';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { createRun, createUnit, readRunUnits, readUnit } from '../src/graph/fill-state.js';

test('reading a run batches unit owners without query growth per unit', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    for (const runId of ['small', 'large']) await createRun(owner, { runId, product: 'batch-product', at: 1 });
    const options = { product: 'batch-product', stageId: 'source', inputsDigest: 'digest', retries: 2, at: 2 };
    await createUnit(owner, { ...options, unitId: 'source/small', scopeKey: 'small', runId: 'small' });
    const names = ['z', 'a', 'A', 'é', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    for (const name of names) await createUnit(owner, { ...options, unitId: `source/${name}`, scopeKey: name, runId: 'large' });
    let queries = 0;
    const counting = Object.create(owner) as TestDatabaseOwner;
    counting.transaction = async (kind, work) => await owner.transaction(kind, async tx => await work({
      query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        queries += 1;
        return await tx.query<Row>(sql, values);
      },
    }));
    const small = await readRunUnits(counting, 'small');
    const oneCost = queries;
    queries = 0;
    const large = await readRunUnits(counting, 'large');
    expect(small).toHaveLength(1);
    expect(large).toHaveLength(12);
    expect(queries).toBeLessThanOrEqual(oneCost);
    expect(large.map(unit => unit.unitId)).toEqual(['A', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'z', 'é'].map(name => `source/${name}`));
    for (const unit of large) {
      expect(unit.runId).toBe('large');
      expect(await readUnit(owner, unit.unitId)).toEqual(unit);
    }
    expect(small[0]?.runId).toBe('small');
  } finally { await owner.close(); }
}, 60_000);
