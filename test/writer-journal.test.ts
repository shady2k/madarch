/**
 * The core's journal of the writer's agent (madarch-m38l.13): one record per call the agent makes to a unit's tools
 * and one per request madarch refuses, whatever the agent was. The reading side is what survives the writer's move to
 * the generated one graph: a run's file, its records and the page a unit wrote are read back from the store.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journalOfUnit, NO_COUNTERS, readJournalFile } from '../src/writer/journal.js';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-journal-'));
  folders.push(folder);
  return folder;
}

/** One line of a run's journal, as the process that serves the agent's tools writes it. */
function line(unit: string, kind: 'tool-call' | 'refusal', tool: string, outcome: 'ok' | 'rejected'): string {
  return JSON.stringify({
    schema: 'madarch.agent-journal@1',
    time: '2026-10-23T10:00:00.000Z',
    durationMs: 1,
    traceId: 'run-a',
    spanId: 'a'.repeat(16),
    run: 'run-a',
    unit,
    agent: 'fake',
    model: null,
    session: null,
    kind,
    tool,
    arguments: {},
    response: '{}',
    responseBytes: 2,
    truncated: false,
    isError: kind === 'refusal',
    outcome,
    reason: kind === 'refusal' ? 'no' : null,
  });
}

describe('a journal record', () => {
  test('a journal file reads back, and names the file and line of one it cannot read', () => {
    const folder = scratch();
    const run = 'run-a';
    const file = join(folder, `${run}.jsonl`);
    writeFileSync(file, [
      line('product:tiny', 'tool-call', 'overview', 'ok'),
      line('domain:other', 'refusal', 'fs/read_text_file', 'rejected'),
    ].join('\n') + '\n');
    appendFileSync(file, 'not json\n');
    const read = readJournalFile(file);
    expect(read.records.map((record) => record.tool)).toEqual(['overview', 'fs/read_text_file']);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toContain(`${file}:3:`);
    const mine = journalOfUnit(folder, 'product:tiny');
    expect(mine.run).toBe(run);
    expect(mine.runs).toEqual([run]);
    expect(mine.records.map((record) => record.tool)).toEqual(['overview']);
    expect(journalOfUnit(folder, 'product:none').run).toBeNull();
    expect(journalOfUnit(join(folder, 'missing'), 'product:tiny')).toEqual({ run: null, runs: [], records: [], totals: NO_COUNTERS, problems: [] });
  });
});
