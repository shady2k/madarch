import { expect, test } from 'bun:test';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { createRun, advanceUnitIn, replaceStaleGenerationIn } from '../src/graph/fill-state.js';
import { createUnit } from './fill-unit-fixture.js';
import { writeOrchestration, recordUnitPlanIn, readRunPlans, readUnitPlan } from '../src/graph/fill-orchestration.js';

test('run plans batch units and versions without per-unit query growth', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    for (const runId of ['small', 'large']) await createRun(owner, { runId, product: 'plan-product', at: 1 });
    const names = ['z', 'a', 'A', 'é', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    for (const [runId, units] of [['small', ['small']], ['large', names]] as const) {
      for (const [position, name] of units.entries()) {
        const unitId = `source/${name}`;
        await createUnit(owner, { unitId, product: 'plan-product', runId, stageId: 'source', scopeKey: name, inputsDigest: 'digest', retries: 2, at: 2 });
        await writeOrchestration(owner, tx => recordUnitPlanIn(tx, { unitId, generation: 1, runId, stageId: 'source', stageUnitId: name, scope: name, stagePosition: 2, planPosition: position, at: 3, cacheVersions: { source: '1', schema: name } }));
      }
    }
    let queries = 0;
    const counting = Object.create(owner) as TestDatabaseOwner;
    counting.transaction = async (kind, work) => await owner.transaction(kind, async tx => await work({
      query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        queries += 1;
        return await tx.query<Row>(sql, values);
      },
    }));
    expect(await readRunPlans(counting, 'small')).toHaveLength(1);
    const oneCost = queries;
    queries = 0;
    const large = await readRunPlans(counting, 'large');
    console.log('run plan reads', { one: oneCost, twelve: queries });
    expect(large).toHaveLength(12);
    expect(queries).toBeLessThanOrEqual(oneCost);
    expect(large.map(plan => plan.unitId)).toEqual(['A', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'z', 'é'].map(name => `source/${name}`));
    for (const plan of large) expect(await readUnitPlan(owner, plan.unitId, plan.generation)).toEqual(plan);
    expect(await readRunPlans(owner, 'absent')).toEqual([]);
    const unitId = 'source/small';
    for (const event of [
      { type: 'admit' as const, at: 4, generation: 1 },
      { type: 'start' as const, at: 5, generation: 1, fence: 1 },
      { type: 'complete' as const, at: 6, generation: 1, fence: 1 },
      { type: 'invalidate' as const, at: 7, replacement: 2, cause: 'inputs changed' },
    ]) expect((await writeOrchestration(owner, tx => advanceUnitIn(tx, { unitId, event }))).ok).toBe(true);
    await createRun(owner, { runId: 'next', product: 'plan-product', at: 8 });
    expect((await writeOrchestration(owner, tx => replaceStaleGenerationIn(tx, { unitId, runId: 'next', inputsDigest: 'next', retries: 2, at: 9 }))).ok).toBe(true);
    await writeOrchestration(owner, tx => recordUnitPlanIn(tx, { unitId, generation: 2, runId: 'next', stageId: 'source', stageUnitId: 'small', scope: 'changed', stagePosition: 0, planPosition: 0, at: 10 }));
    expect(await readRunPlans(owner, 'small')).toEqual([]);
    expect(await readRunPlans(owner, 'small', { history: true })).toEqual([(await readUnitPlan(owner, unitId, 1))!]);
    expect(await readRunPlans(owner, 'next')).toEqual([(await readUnitPlan(owner, unitId, 2))!]);
  } finally { await owner.close(); }
}, 60_000);
