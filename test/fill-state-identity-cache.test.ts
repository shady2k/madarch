/**
 * A store remembers the vertex a name resolved to, and publishes that memory with the transaction that
 * found or made it (madarch-64o5.176, F1). A planning transaction that rolls back — an error before
 * COMMIT, a deferred graph check, a cancel — leaves nothing behind, so the next planning of the same
 * unit answers the generation it made. Before this, the rolled-back generation stayed in the process's
 * memory: the plan was published on a vertex no transaction had committed, and the unit's own record
 * carried no plan at all, which is what a single fill of a long-lived process would keep doing.
 */
import { expect, test } from 'bun:test';
import { createRun, createUnitIn, readUnitGraphUidIn } from '../src/graph/fill-state.js';
import { readRunPlans, recordUnitPlanIn } from '../src/graph/fill-orchestration.js';
import { acquireGraphWriteLock } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

test('a planning transaction that rolls back leaves no generation remembered', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await createRun(owner, { runId: 'r', product: 'shop', at: 1 });
    const unit = { unitId: 'u', product: 'shop', runId: 'r', stageId: 's', scopeKey: 'k', inputsDigest: 'd', retries: 0, at: 2 };
    const plan = { runId: 'r', unitId: 'u', generation: 1, stageId: 's', stageUnitId: 's', scope: 'k', stagePosition: 0, planPosition: 0, at: 2 };
    let ghost: string | undefined;
    const aborted = owner.transaction('write', async tx => {
      await acquireGraphWriteLock(tx);
      await createUnitIn(tx, unit);
      await recordUnitPlanIn(tx, plan);
      ghost = await readUnitGraphUidIn(tx, 'u', 1);
      throw new Error('injected abort before commit');
    });
    await expect(aborted).rejects.toThrow('injected abort before commit');
    await owner.transaction('write', async tx => {
      await acquireGraphWriteLock(tx);
      await createUnitIn(tx, unit);
      await recordUnitPlanIn(tx, plan);
    });
    const remembered = await owner.transaction('write', async tx => await readUnitGraphUidIn(tx, 'u', 1));
    const nodes = await owner.run(async tx => (await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.unit' ORDER BY n.id")).rows.map(row => row.uid));
    const plans = await readRunPlans(owner, 'r');
    // The generation the rollback took away is not the one the store names: the next planning made its own,
    // and the plan stands on it. Before this, the remembered generation was the rolled-back one, a ghost
    // vertex carried the plan, and the unit the store holds had none.
    expect(remembered).not.toBe(ghost);
    expect(nodes.length).toBe(1);
    expect(remembered).toBe(nodes[0]!);
    expect(plans.length).toBe(1);
  } finally { await owner.close(); }
}, 60_000);
