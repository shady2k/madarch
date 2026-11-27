/**
 * A store remembers the vertex a name resolved to, and publishes that memory with the transaction that
 * found or made it (madarch-64o5.176, F1). A planning transaction that rolls back — an error before
 * COMMIT, a deferred graph check, a cancel — leaves nothing behind, so the next planning of the same
 * unit answers the generation it made. Before this, the rolled-back generation stayed in the process's
 * memory: the plan was published on a vertex no transaction had committed, and the unit's own record
 * carried no plan at all, which is what a single fill of a long-lived process would keep doing.
 *
 * The other half of that bargain is what a commit buys: once the transaction that found a name has
 * committed, the next one answers it from the memory and walks no name's value table at all.
 */
import { expect, test } from 'bun:test';
import { createRun, createUnitIn, readRunGraphUidIn, readUnitGraphUidIn } from '../src/graph/fill-state.js';
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

test('a committed transaction publishes what a name resolved to, so the next one looks nothing up', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await createRun(owner, { runId: 'r', product: 'shop', at: 1 });
    await owner.transaction('write', async tx => {
      await acquireGraphWriteLock(tx);
      await createUnitIn(tx, { unitId: 'u', product: 'shop', runId: 'r', stageId: 's', scopeKey: 'k', inputsDigest: 'd', retries: 0, at: 2 });
    });
    // One committed transaction that resolves both names: what it found is published with its commit.
    const resolved = await owner.transaction('write', async tx => await ({ run: await readRunGraphUidIn(tx, 'r'), unit: await readUnitGraphUidIn(tx, 'u', 1) }));
    // The next transaction answers from that memory. Its own statements are the ones this counts, and it
    // is the transaction's own object whose query is measured, so the owner still knows this executor and
    // still runs the commit that publishes what the transaction stages.
    const next = await owner.transaction('write', async tx => {
      const statements: string[] = [];
      const read = tx.query.bind(tx);
      (tx as { query: typeof tx.query }).query = async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        statements.push(sql);
        return await read<Row>(sql, values);
      };
      const run = await readRunGraphUidIn(tx, 'r');
      const unit = await readUnitGraphUidIn(tx, 'u', 1);
      return { run, unit, lookups: statements.filter(sql => sql.includes('SELECT DISTINCT n.id::text AS id,n.uid::text AS uid,n.key')).length };
    });
    expect(next.run).toBe(resolved.run);
    expect(next.unit).toBe(resolved.unit);
    expect(next.lookups, "name lookups after a committed transaction published what it resolved").toBe(0);
  } finally { await owner.close(); }
}, 60_000);
