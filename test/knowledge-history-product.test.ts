/**
 * A product page's history is one bounded story, not a bound per repository (madarch-ztyq.7 review): twenty
 * repositories must not turn a five-row rest into twenty summaries and a hundred hotspots.
 */
import { describe, expect, test } from 'bun:test';
import type { GraphEntity, HistoryEvidence } from '../src/knowledge/graph-read.js';
import { projectHistoryAcross } from '../src/knowledge/history-evidence.js';

const entity = (key: string, kind: string, properties: Record<string, unknown> = {}): GraphEntity => ({
  key, kind, label: key, properties, nodeIds: [key], scope: '1',
});

function repository(index: number): HistoryEvidence {
  const repo = entity(`code.repository:r${index}`, 'code.repository');
  const commit = entity(`code.commit:r${index}`, 'code.commit', { effectiveAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`, merge: false });
  const file = entity(`code.file:r${index}/a.ts`, 'code.file');
  const author = entity(`code.author:a${index}`, 'code.author');
  return { entities: [repo, commit, file, author], edges: [
    { from: commit.key, to: author.key, relation: 'code.authored', properties: {} },
    { from: commit.key, to: file.key, relation: 'code.touched', properties: { additions: 1, deletions: 0 } },
  ] };
}

describe('a product history is budgeted across repositories', () => {
  test('twenty repositories give one summary and at most the limit of hotspots', () => {
    const projected = projectHistoryAcross(Array.from({ length: 20 }, (_, index) => repository(index)), 5, (one) => one as never);
    const shown = projected.sections.filter((section) => section.role === 'summary' || section.role === 'hotspots');
    expect(shown.map((section) => section.role)).toEqual(['summary', 'hotspots']);
    expect(shown[0]!.rows).toHaveLength(1);
    expect(shown[1]!.rows).toHaveLength(5);
    expect(shown[1]!.total).toBe(20);
    expect(shown.reduce((count, section) => count + section.rows.length, 0)).toBe(6);
  });
});
