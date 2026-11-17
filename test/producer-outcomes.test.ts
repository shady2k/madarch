import { describe, expect, test } from 'bun:test';
import { producerSucceeded } from '../src/fill/producer-outcomes.js';
import { readProducerOutcomes, readProducerOutcomesIn } from '../src/graph/producer-outcomes.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { ensureVertex, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';

describe('observable producer completion', () => {
  test('empty checks succeed and abstention is not successful completion', () => {
    for (const outcome of ['completed', 'unchanged', 'empty'] as const) expect(producerSucceeded(outcome)).toBe(true);
    for (const outcome of ['abstained', 'failed'] as const) expect(producerSucceeded(outcome)).toBe(false);
  });

  test('reads graph-only outcomes with scalar identity and run-edge filters, optional metadata and code-point ordering', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      await owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, EMPTY_CONTRACT);
        let originalUnitUid = '';
        const runs = new Map<string, { nodeId: string; uid: string }>();
        for (const [runId, unitId, generation, metadata] of [
          ['first', 'z-unit', 1, { producer: 'check', outcome: 'completed', produced: 2, reason: 'partial answer', producer_version: 'v1' }],
          ['first', 'a-unit', 2, { producer: 'check', outcome: 'empty', produced: 0 }],
          ['first', 'a-unit', 1, { producer: 'check', outcome: 'failed', produced: 0, reason: 'adapter crashed' }],
          ['second', 'a-unit', 2, { producer: 'check', outcome: 'unchanged', produced: 1 }],
          ['first', 'pending', 1, {}],
        ] as const) {
          let run = runs.get(runId);
          if (run === undefined) {
            run = await ensureVertex(tx, EMPTY_CONTRACT, { kind: 'system.run', key: {}, uid: newUid() });
            for (const [property, value] of Object.entries({ $exists: true, run_name: runId })) {
              await writeAssertion(tx, EMPTY_CONTRACT, { sort: 'vertex', kind: 'system.run', subjectId: run.nodeId, property, operation: 'assert', value });
            }
            runs.set(runId, run);
          }
          const subject = await ensureVertex(tx, EMPTY_CONTRACT, { kind: 'system.unit', key: {}, uid: newUid() });
          if (unitId === 'z-unit') originalUnitUid = subject.uid;
          for (const [property, value] of Object.entries({ $exists: true, unit_name: unitId, generation, produced_kind: 'Problem', ...metadata })) {
            await writeAssertion(tx, EMPTY_CONTRACT, { sort: 'vertex', kind: 'system.unit', subjectId: subject.nodeId, property, operation: 'assert', value });
          }
          await publishGraphDrafts(tx, EMPTY_CONTRACT, { vertices: [], removals: [], edges: [{
            kind: 'system.unit-run', from: { kind: 'system.unit', key: {}, uid: subject.uid },
            to: { kind: 'system.run', key: {}, uid: run.uid }, producer: 'fixture', producerVersion: '1',
          }] });
        }
        await publishGraphDrafts(tx, EMPTY_CONTRACT, { vertices: [], removals: [], edges: [{
          kind: 'system.run-inherited-unit', from: { kind: 'system.run', key: {}, uid: runs.get('second')!.uid },
          to: { kind: 'system.unit', key: {}, uid: originalUnitUid }, producer: 'fixture', producerVersion: '1',
        }] });
      });
      const first = await readProducerOutcomes(owner, { runId: 'first' });
      expect(first).toEqual([
        { runId: 'first', unitId: 'a-unit', generation: 1, plugin: 'check', kind: 'Problem', outcome: 'failed', produced: 0, reason: 'adapter crashed' },
        { runId: 'first', unitId: 'a-unit', generation: 2, plugin: 'check', kind: 'Problem', outcome: 'empty', produced: 0 },
        { runId: 'first', unitId: 'z-unit', generation: 1, plugin: 'check', kind: 'Problem', outcome: 'completed', produced: 2, reason: 'partial answer', producerVersion: 'v1' },
      ]);
      expect(await readProducerOutcomes(owner, { unitId: 'a-unit', generation: 2 })).toEqual([
        first[1]!, { runId: 'second', unitId: 'a-unit', generation: 2, plugin: 'check', kind: 'Problem', outcome: 'unchanged', produced: 1 },
      ]);
      expect(await readProducerOutcomes(owner, { runId: 'second', unitId: 'z-unit' })).toEqual([{ ...first[2]!, runId: 'second', outcome: 'unchanged' }]);
      expect(await readProducerOutcomes(owner, { runId: 'first' })).toEqual(first);
      expect(await readProducerOutcomes(owner, { runId: 'missing' })).toEqual([]);
      await owner.transaction('snapshot', async tx => {
        const queries: string[] = [];
        const executor = { query: async <R extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          queries.push(sql);
          return await tx.query<R>(sql, values);
        } };
        expect(await readProducerOutcomesIn(executor, {})).toHaveLength(5);
        expect(queries.some(sql => /fill_unit|fill_event|fill_publication/.test(sql))).toBe(false);
      });
    } finally {
      await owner.close();
    }
  });
});
