/**
 * The core's journal counts what a call did, not only that it was made (madarch-m38l.13, decision 0032
 * section 2): the counters a record holds, how two of them add, and the totals a page's journal reads.
 */
import { describe, expect, test } from 'bun:test';
import { addCounters, countersOf, journalOfUnit, NO_COUNTERS } from '../src/writer/journal.js';

describe('the journal counts what a call did, not only that it was made', () => {
  test('a line without counters reads as none, and a partial line fills every missing field with none', () => {
    const counters = { sourceBytes: { served: 10, repeated: 4 }, evidence: 2, unresolvedJoins: 1, produced: { pages: 1, statements: 2, grounds: 2, links: 1, questions: 0 } };
    expect(countersOf(counters)).toEqual(counters);
    expect(countersOf(undefined)).toEqual(NO_COUNTERS);
    expect(countersOf({ sourceBytes: { served: 3 }, produced: { pages: 1 } })).toEqual({ sourceBytes: { served: 3, repeated: 0 }, evidence: 0, unresolvedJoins: 0, produced: { pages: 1, statements: 0, grounds: 0, links: 0, questions: 0 } });
  });

  test('two counts add field by field', () => {
    const before = { sourceBytes: { served: 10, repeated: 0 }, evidence: 2, unresolvedJoins: 0, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } };
    const after = { sourceBytes: { served: 16, repeated: 3 }, evidence: 5, unresolvedJoins: 1, produced: { pages: 1, statements: 0, grounds: 0, links: 0, questions: 0 } };
    expect(addCounters(before, after)).toEqual({ sourceBytes: { served: 26, repeated: 3 }, evidence: 7, unresolvedJoins: 1, produced: { pages: 1, statements: 0, grounds: 0, links: 0, questions: 0 } });
  });

  test('a run\'s journal adds its records up, so a page shows what its unit read twice and produced', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = mkdtempSync(join(tmpdir(), 'madarch-counters-'));
    try {
      const journal = join(folder, 'journal');
      mkdirSync(journal);
      const line = (tool: string, counters: unknown): string => JSON.stringify({ schema: 'madarch.agent-journal@1', time: '2026-10-20T10:00:00.000Z', durationMs: 1, traceId: 't', spanId: 's', run: 'run-counters', unit: 'domain:payments', agent: 'fake', model: null, session: null, kind: 'tool-call', tool, arguments: {}, response: '{}', responseBytes: 2, truncated: false, isError: false, outcome: 'ok', reason: null, counters, attributes: {} });
      writeFileSync(join(journal, 'run-counters.jsonl'), [
        line('read_file', { sourceBytes: { served: 100, repeated: 0 }, evidence: 1, unresolvedJoins: 0, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } }),
        line('read_file', { sourceBytes: { served: 0, repeated: 100 }, evidence: 0, unresolvedJoins: 2, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } }),
        line('write_page', { sourceBytes: { served: 0, repeated: 0 }, evidence: 3, unresolvedJoins: 0, produced: { pages: 1, statements: 4, grounds: 4, links: 2, questions: 0 } }),
      ].join('\n'));
      const page = journalOfUnit(journal, 'domain:payments');
      expect(page.records).toHaveLength(3);
      expect(page.totals).toEqual({ sourceBytes: { served: 100, repeated: 100 }, evidence: 4, unresolvedJoins: 2, produced: { pages: 1, statements: 4, grounds: 4, links: 2, questions: 0 } });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
