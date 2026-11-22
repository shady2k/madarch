import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { createRun, createUnitIn, advanceUnitIn, bindFillStateIn, readUnit, readRecordsIn, edgeRowsIn, readUnitGraphUidIn, readNodeIdIn } from '../src/graph/fill-state.js';
import { boundWriteCapability, unbindWriteCapability } from '../src/graph/write.js';
import { openTrace, runInTrace, closeTrace } from '../src/obs/trace.js';
import { readTraceSpans } from '../src/obs/trace-report.js';

test('a unit creation and step each publish state and journal in one graph batch', async () => {
  const owner = await createTestDatabaseOwner();
  const store = mkdtempSync(join(tmpdir(), 'madarch-state-batch-'));
  try {
    await createRun(owner, { runId: 'batch', product: 'batch', at: 1 });
    const counts: number[] = [];
    for (const phase of ['create', 'admit'] as const) {
      await owner.transaction('write', async tx => {
        await bindFillStateIn(tx);
        const prior = boundWriteCapability(tx);
        if (phase === 'create') unbindWriteCapability(tx);
        const before = boundWriteCapability(tx);
        const trace = openTrace({ store, runId: phase, console: false });
        try {
          await runInTrace(trace, async () => {
            if (phase === 'create') await createUnitIn(tx, { unitId: 'unit', product: 'batch', runId: 'batch', stageId: 'stage', scopeKey: 'scope', inputsDigest: 'digest', retries: 2, at: 2 });
            else expect((await advanceUnitIn(tx, { unitId: 'unit', event: { type: 'admit', at: 3, generation: 1 } })).ok).toBe(true);
          });
        } finally { closeTrace(trace); }
        counts.push(readTraceSpans(trace.file).filter(span => span.name === 'graph.publish').length);
        expect(boundWriteCapability(tx)).toEqual(before);
        if (phase === 'admit') expect(before).toBe(prior);
      });
    }
    console.log('unit state publication batches', counts);
    expect(counts).toEqual([1, 1]);
    expect((await readUnit(owner, 'unit'))?.state).toBe('ready');
    const journals = await owner.transaction('snapshot', async tx => {
      const uid = await readUnitGraphUidIn(tx, 'unit');
      const id = await readNodeIdIn(tx, uid!);
      const links = await edgeRowsIn(tx, 'system.fill-transition-subject', 'to', [id!]);
      return await readRecordsIn(tx, 'vertex', 'system.fill-transition', ['step', 'from_state', 'to_state', 'event', 'at', 'fence'], links.map(link => link.from));
    });
    expect(journals.map(row => row.values.event).sort()).toEqual(['admit', 'create']);
    expect(journals.find(row => row.values.event === 'create')?.values).toMatchObject({ from_state: '(none)', to_state: 'planned', at: 2, fence: 0 });
    expect(journals.find(row => row.values.event === 'admit')?.values).toMatchObject({ from_state: 'planned', to_state: 'ready', at: 3, fence: 0 });
  } finally { await owner.close(); rmSync(store, { recursive: true, force: true }); }
}, 30_000);
