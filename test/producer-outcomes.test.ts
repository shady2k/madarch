import { describe, expect, test } from 'bun:test';
import { producerSucceeded, retainedProducerOutcomes, readProducerOutcomesIn } from '../src/fill/producer-outcomes.js';
import type { SqlExecutor } from '../src/sql-driver.js';

describe('observable producer completion', () => {
  test('empty checks succeed and abstention is not successful completion', () => {
    for (const outcome of ['completed', 'unchanged', 'empty'] as const) expect(producerSucceeded(outcome)).toBe(true);
    for (const outcome of ['abstained', 'failed'] as const) expect(producerSucceeded(outcome)).toBe(false);
  });
  test('retains immutable plugin values, grounds and version but not static bulk copies', () => {
    const vertex = { kind: 'vertex', value: { kind: 'Problem', key: { id: 'one' }, values: { title: 'bad' }, producer: 'check', producerVersion: 'v1', evidence: [{ path: 'source.md', commit: 'abc' }] } };
    expect(retainedProducerOutcomes([vertex], 1)).toEqual([]);
    const outcome = { kind: 'producer-outcome', value: { plugin: 'check', kind: 'Problem', outcome: 'completed', produced: 1 } };
    const snapshot = retainedProducerOutcomes([vertex, outcome, { kind: 'journal', value: {} }], 0);
    expect(snapshot).toEqual([vertex, { ...outcome, value: { ...outcome.value, outcome: 'unchanged' } }]);
    const empty = { kind: 'producer-outcome', value: { plugin: 'check', kind: 'Problem', outcome: 'empty', produced: 0 } };
    expect(retainedProducerOutcomes([empty], 1)).toEqual([empty]);
  });
  test('reads committed zero-Problem outcomes and terminal failures, not private failed drafts', async () => {
    const rows = [
      { run_id: 'zero', unit_id: 'plugin-turns/check:Problem', generation: 2, scope_key: 'check:Problem', state: 'published', writes: [{ kind: 'producer-outcome', value: { plugin: 'check', kind: 'Problem', outcome: 'empty', produced: 0 } }], published: true, reason: null },
      { run_id: 'rechecked', unit_id: 'plugin-turns/check:Problem', generation: 2, scope_key: 'check:Problem', state: 'published', writes: [{ kind: 'producer-outcome', value: { plugin: 'check', kind: 'Problem', outcome: 'completed', produced: 1 } }], published: true, inherited: true, reason: null },
      { run_id: 'failed', unit_id: 'plugin-turns/check:Problem', generation: 3, scope_key: 'check:Problem', state: 'failed', writes: [{ kind: 'producer-outcome', value: { outcome: 'completed' } }], published: false, reason: 'adapter crashed' },
    ];
    const executor = { query: async () => ({ rows }) } as unknown as SqlExecutor;
    expect(await readProducerOutcomesIn(executor, { unitId: 'plugin-turns/check:Problem' })).toEqual([
      { runId: 'zero', unitId: 'plugin-turns/check:Problem', generation: 2, plugin: 'check', kind: 'Problem', outcome: 'empty', produced: 0 },
      { runId: 'rechecked', unitId: 'plugin-turns/check:Problem', generation: 2, plugin: 'check', kind: 'Problem', outcome: 'unchanged', produced: 1 },
      { runId: 'failed', unitId: 'plugin-turns/check:Problem', generation: 3, plugin: 'check', kind: 'Problem', outcome: 'failed', produced: 0, reason: 'adapter crashed' },
    ]);
  });
});
