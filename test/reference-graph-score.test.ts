/**
 * The scorer's edge accounting (`scripts/score-reference-graph.ts`): a relation's
 * graph is the edges that are its true positives plus the edges no reference
 * edge explains, and an edge that touches a kind the reference keeps apart is in
 * neither side — it is reported apart. Fixtures only: canonical edges over
 * synthetic record keys, the match's pairings, and no database.
 */
import { describe, expect, test } from 'bun:test';
import { classifyEdges, edgeRowCounts, type ScoredReferenceEdge } from '../scripts/score-reference-graph.js';
import type { CanonicalEdge } from '../scripts/reference-graph-catalog.js';

function edge(relation: string, from: string, to: string): CanonicalEdge {
  return { relation, from, to };
}

describe('classifyEdges', () => {
  test('an edge with an end of a kind the reference keeps apart is apart, and never in scope', () => {
    const kindOf = new Map<string, string>([
      ['f', 'code.file'], ['s', 'code.symbol'], ['b', 'code.binding'],
    ]);
    const classified = classifyEdges(
      [edge('contains', 'f', 's'), edge('contains', 'f', 'b'), edge('contains', 's', 'b')],
      kindOf,
      new Set(['code.file', 'code.symbol']),
    );
    expect(classified.inScope).toEqual([edge('contains', 'f', 's')]);
    expect(classified.apart).toEqual([{ kind: 'code.binding', count: 2 }]);
  });

  test('two raw edges with one relation and one pair of ends are one edge in scope', () => {
    const classified = classifyEdges(
      [edge('contains', 'f', 's'), edge('contains', 'f', 's')],
      new Map([['f', 'code.file'], ['s', 'code.symbol']]),
      new Set(['code.file', 'code.symbol']),
    );
    expect(classified.inScope).toHaveLength(1);
    expect(classified.apart).toEqual([]);
  });
});

describe('edgeRowCounts', () => {
  // One relation with a parsed reference edge the graph states, a graph edge
  // between records the reference has entries for but the reference states no
  // edge for, and a graph edge whose end the reference has no entry for.
  const inScope = [edge('contains', 'f', 's1'), edge('contains', 'f', 's2'), edge('contains', 'f', 'x')];
  const referenceEdges: ScoredReferenceEdge[] = [
    { relation: 'contains', from: 'E:file', to: 'E:s1', class: 'parsed+declared' },
  ];
  const recordToEntry = new Map<string, string>([['f', 'E:file'], ['s1', 'E:s1'], ['s2', 'E:s2']]);
  const matched = new Set<string>(['contains\u0000E:file\u0000E:s1']);
  const { rows, extras } = edgeRowCounts({ inScope, relations: ['contains'], referenceEdges, matched, recordToEntry });

  test('a relation row is its true positives and its extras, and the two account for its graph', () => {
    for (const row of rows) expect(row.truePositives + row.extra).toBe(row.graph);
    const parsed = rows.find((row) => row.class === 'parsed+declared')!;
    expect(parsed).toEqual({ relation: 'contains', class: 'parsed+declared', reference: 1, graph: 3, truePositives: 1, extra: 2 });
    const judgement = rows.find((row) => row.class === 'judgement')!;
    expect(judgement).toEqual({ relation: 'contains', class: 'judgement', reference: 0, graph: 0, truePositives: 0, extra: 0 });
  });

  test('the extras are the writes the reference states no edge for, each in the row that counts it', () => {
    expect(extras).toEqual([
      { relation: 'contains', from: 'f', to: 's2', class: 'parsed+declared' },
      { relation: 'contains', from: 'f', to: 'x', class: 'parsed+declared' },
    ]);
    expect(extras.reduce((sum, one) => sum + (one.class === 'parsed+declared' ? 1 : 0), 0)).toBe(2);
  });

  test('a second graph edge for one reference edge is an extra: one reference fact has one witness', () => {
    const duplicated = edgeRowCounts({
      inScope: [edge('contains', 'f', 's1'), edge('contains', 'f', 's1b')],
      relations: ['contains'],
      referenceEdges,
      matched,
      recordToEntry: new Map([['f', 'E:file'], ['s1', 'E:s1'], ['s1b', 'E:s1']]),
    });
    const parsed = duplicated.rows.find((row) => row.class === 'parsed+declared')!;
    expect(parsed.truePositives).toBe(1);
    expect(parsed.extra).toBe(1);
    expect(parsed.graph).toBe(2);
  });

  test('a relation the reference states only as a judgement counts its extras in that row', () => {
    const judged = edgeRowCounts({
      inScope: [edge('covers', 'm', 't')],
      relations: ['covers'],
      referenceEdges: [{ relation: 'covers', from: 'E:m', to: 'E:t', class: 'judgement' }],
      matched: new Set<string>(),
      recordToEntry: new Map([['m', 'E:m'], ['t', 'E:t']]),
    });
    const judgement = judged.rows.find((row) => row.class === 'judgement')!;
    expect(judgement).toEqual({ relation: 'covers', class: 'judgement', reference: 1, graph: 1, truePositives: 0, extra: 1 });
    expect(judgement.truePositives + judgement.extra).toBe(judgement.graph);
  });
});
