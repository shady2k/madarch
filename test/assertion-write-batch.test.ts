import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { createRun, createUnit, readUnitGraphUidIn, readNodeIdIn, readRecordsIn } from '../src/graph/fill-state.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { writeAssertions } from '../src/graph/write.js';
import { openTrace, runInTrace, closeTrace } from '../src/obs/trace.js';
import { readTraceSpans } from '../src/obs/trace-report.js';

test('multiple assertions use one admission and retain ordered assertion identities and values', async () => {
  const owner = await createTestDatabaseOwner();
  const store = mkdtempSync(join(tmpdir(), 'madarch-assertion-batch-'));
  try {
    await createRun(owner, { runId: 'batch', product: 'batch', at: 1 });
    await createUnit(owner, { unitId: 'unit', product: 'batch', runId: 'batch', stageId: 'stage', scopeKey: 'scope', inputsDigest: 'digest', retries: 0, at: 2 });
    const fields = [['produced_kind', 'example.kind'], ['producer', 'example'], ['outcome', 'produced'], ['produced', 3], ['reason', 'done'], ['producer_version', '1']] as const;
    const costs: number[] = [];
    for (const count of [1, 6]) {
      await owner.transaction('write', async tx => {
        const {contract} = await startupBinding(tx, owner.graphContract, 'assertion-batch');
        const uid = await readUnitGraphUidIn(tx, 'unit');
        const id = await readNodeIdIn(tx, uid!);
        const trace = openTrace({ store, runId: `fields-${count}`, console: false });
        let ids: string[];
        try {
          ids = await runInTrace(trace, async () => await writeAssertions(tx, contract, fields.slice(0, count).map(([property, value]) => ({sort: 'vertex', kind: 'system.unit', subjectId: String(id), property, operation: 'assert', value}))));
        } finally { closeTrace(trace); }
        costs.push(readTraceSpans(trace.file).filter(span => span.name === 'graph.write.admitAssertionInputs').length);
        expect(ids).toHaveLength(count);
        expect(new Set(ids).size).toBe(count);
        const held = await readRecordsIn(tx, 'vertex', 'system.unit', fields.slice(0, count).map(([property]) => property), [id!]);
        for (const [position, [property, value]] of fields.slice(0, count).entries()) {
          const assertion = held[0]!.assertions.find(row => row.id === ids[position]);
          expect(assertion?.property).toBe(property);
          expect(assertion?.value).toBe(value);
        }
      });
    }
    console.log('assertion admission calls', costs);
    expect(costs).toEqual([1, 1]);
  } finally { await owner.close(); rmSync(store, { recursive: true, force: true }); }
}, 30_000);
