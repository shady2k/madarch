/**
 * The match by place (`scripts/reference-graph-by-place.ts`): a record is found
 * by where it stands, not by how it is spelled. Fixtures only: entries of two
 * kinds, records with and without places, an ambiguous overlap, a fact with no
 * file matched by its identity, an entry and an edge taken out by `scored:
 * false`, an edge out of the direct counts by its scope, and a `SCORING.md`.
 */
import { describe, expect, test } from 'bun:test';
import {
  edgeKey, IDENTITY_KINDS, identityOfEntry, matchEdges, matchNodes, placeOfProperties, placesOf, readScoring, statedName,
  type GraphEdge, type NodeRecord, type ReferenceEdge, type ReferenceEntry,
} from '../scripts/reference-graph-by-place.js';

function entry(id: string, kind: string, lines: readonly [string, number, number][], scored?: boolean): ReferenceEntry {
  return {
    id,
    kind,
    ...(scored === undefined ? {} : { scored }),
    evidence: lines.length === 0 ? [{ command: 'git log -1 --format=%s abc' }] : lines.map(([path, startLine, endLine]) => ({ path, startLine, endLine })),
  };
}

function record(key: string, kind: string, place?: [string, number, number], name?: string, identity?: string): NodeRecord {
  return { key, kind, ...(place === undefined ? {} : { place: { path: place[0], startLine: place[1], endLine: place[2] } }), ...(name === undefined ? {} : { name }), ...(identity === undefined ? {} : { identity }) };
}

describe('the entries as the match reads them', () => {
  test('an entry states a name and a place', () => {
    const one = entry('code.symbol:a.go#Order.Apply', 'code.symbol', [['a.go', 17, 17]]);
    expect(statedName(one)).toBe('Order.Apply');
    expect(identityOfEntry(one)).toBe('a.go#Order.Apply');
    expect(placesOf(one)).toEqual([{ path: 'a.go', startLine: 17, endLine: 17 }]);
  });
});

describe('placeOfProperties', () => {
  test('a record\'s own span, its provenance\'s place, a file with a line, and a file record', () => {
    expect(placeOfProperties('code.symbol', { span: { path: 'a.go', lineStart: 17, lineEnd: 20 } })).toEqual({ path: 'a.go', startLine: 17, endLine: 20 });
    expect(placeOfProperties('code.document-section', { provenance: { place: { file: 'README.md', range: { startLine: 22, endLine: 30 } } } })).toEqual({ path: 'README.md', startLine: 22, endLine: 30 });
    expect(placeOfProperties('code.state', { file: 'a.go', line: 58 })).toEqual({ path: 'a.go', startLine: 58, endLine: 58 });
    expect(placeOfProperties('code.state-machine', { file: 'a.go', lineStart: 55, lineEnd: 69 })).toEqual({ path: 'a.go', startLine: 55, endLine: 69 });
    expect(placeOfProperties('code.file', { path: 'docs/a.md' })).toEqual({ path: 'docs/a.md', startLine: 1, endLine: Number.MAX_SAFE_INTEGER });
  });

  test('a record that states no place is not given one', () => {
    expect(placeOfProperties('code.state', {})).toBeUndefined();
    expect(placeOfProperties('code.symbol', { file: 'a.go' })).toBeUndefined();
    expect(placeOfProperties('code.module', { name: 'cluster' })).toBeUndefined();
    expect(placeOfProperties('code.table', { path: '/not/a/file-node' })).toBeUndefined();
  });
});

describe('matchNodes', () => {
  test('a kind, a file and an overlapping place find the record', () => {
    const match = matchNodes([entry('code.symbol:a.go#Apply', 'code.symbol', [['a.go', 17, 17]])], [record('k1', 'code.symbol', ['a.go', 15, 20])]);
    expect([...match.entryToRecord.entries()]).toEqual([['code.symbol:a.go#Apply', 'k1']]);
    expect(match.unmatchedRecords).toEqual([]);
  });

  test('another file or another kind finds nothing', () => {
    const one = entry('code.symbol:a.go#Apply', 'code.symbol', [['a.go', 17, 17]]);
    expect(matchNodes([one], [record('k1', 'code.symbol', ['b.go', 17, 17])]).entryToRecord.size).toBe(0);
    expect(matchNodes([one], [record('k1', 'code.field', ['a.go', 17, 17])]).entryToRecord.size).toBe(0);
  });

  test('several records overlapping one entry: the one whose name the entry states wins, without ambiguity', () => {
    const match = matchNodes(
      [entry('code.metric:requests_total', 'code.metric', [['a.go', 53, 53]])],
      [record('k1', 'code.metric', ['a.go', 53, 53], 'created_total'), record('k2', 'code.metric', ['a.go', 53, 53], 'requests_total')],
    );
    expect(match.entryToRecord.get('code.metric:requests_total')).toBe('k2');
    expect(match.ambiguous.size).toBe(0);
    expect(match.unmatchedRecords).toEqual(['k1']);
  });

  test('no name singles one out: the entry is matched once, the rest are extras, the kind is ambiguous', () => {
    const match = matchNodes(
      [entry('code.symbol:a.go#Apply', 'code.symbol', [['a.go', 17, 17]])],
      [record('k1', 'code.symbol', ['a.go', 17, 20], 'Other'), record('k2', 'code.symbol', ['a.go', 17, 17], 'Another')],
    );
    expect(match.entryToRecord.size).toBe(1);
    expect(match.unmatchedRecords.length).toBe(1);
    expect([...match.ambiguous.values()]).toEqual([{ kind: 'code.symbol', entries: 1, records: 1 }]);
  });

  test('a record that states no place is counted as no place, never matched', () => {
    const match = matchNodes([entry('code.state:cancelled', 'code.state', [['a.go', 31, 31]])], [record('k1', 'code.state', undefined, 'cancelled')]);
    expect(match.entryToRecord.size).toBe(0);
    expect([...match.noPlace.entries()]).toEqual([['code.state', 1]]);
  });

  test('a fact with no file is matched by the identity it states', () => {
    expect(IDENTITY_KINDS['code.commit']?.property).toBe('commit');
    const match = matchNodes(
      [entry('code.commit:0657ebc0', 'code.commit', [])],
      [record('k1', 'code.commit', undefined, undefined, '0657ebc0'), record('k2', 'code.commit', undefined, undefined, '28e623ae')],
    );
    expect(match.entryToRecord.get('code.commit:0657ebc0')).toBe('k1');
    expect(match.identity.get('code.commit')).toBe(1);
    expect(match.unmatchedRecords).toEqual(['k2']);
  });

  test('an entry marked scored: false stays out of every count and is reported', () => {
    const match = matchNodes(
      [entry('code.file:a.go', 'code.file', [['a.go', 1, 1]], false), entry('code.file:b.go', 'code.file', [['b.go', 1, 1]])],
      [record('k1', 'code.file', ['a.go', 1, 1]), record('k2', 'code.file', ['b.go', 1, 1])],
    );
    expect([...match.entryToRecord.keys()]).toEqual(['code.file:b.go']);
    expect(match.unscored.map((item) => item.id)).toEqual(['code.file:a.go']);
  });
});

describe('matchEdges', () => {
  const nodes = matchNodes(
    [
      entry('code.symbol:a.go#Apply', 'code.symbol', [['a.go', 17, 17]]),
      entry('code.symbol:a.go#Percent', 'code.symbol', [['a.go', 24, 24]]),
    ],
    [record('k1', 'code.symbol', ['a.go', 17, 17]), record('k2', 'code.symbol', ['a.go', 24, 24])],
  );

  test('an edge matches through both matched ends', () => {
    const edges: ReferenceEdge[] = [{ relation: 'code.calls', from: 'code.symbol:a.go#Apply', to: 'code.symbol:a.go#Percent' }];
    const graph: GraphEdge[] = [{ relation: 'code.calls', from: 'k1', to: 'k2' }];
    const match = matchEdges(edges, graph, nodes.recordToEntry);
    expect([...match.matched]).toEqual([edgeKey('code.calls', 'code.symbol:a.go#Apply', 'code.symbol:a.go#Percent')]);
    expect(match.extra.size).toBe(0);
    expect(match.missing.size).toBe(0);
  });

  test('a graph edge whose end no entry found, or whose relation differs, is an extra', () => {
    const edges: ReferenceEdge[] = [{ relation: 'code.calls', from: 'code.symbol:a.go#Apply', to: 'code.symbol:a.go#Percent' }];
    const unmatched = matchEdges(edges, [{ relation: 'code.calls', from: 'k1', to: 'k9' }], nodes.recordToEntry);
    expect(unmatched.extra.size).toBe(0);
    expect(unmatched.missing.size).toBe(1);
    const other = matchEdges(edges, [{ relation: 'code.uses-type', from: 'k1', to: 'k2' }], nodes.recordToEntry);
    expect(other.extra.size).toBe(1);
    expect(other.missing.size).toBe(1);
  });

  test('a scope other than direct is reported apart, and scored: false edges leave every count', () => {
    const edges: ReferenceEdge[] = [
      { relation: 'code.calls', from: 'code.symbol:a.go#Apply', to: 'code.symbol:a.go#Percent', scope: 'remote' },
      { relation: 'code.calls', from: 'code.symbol:a.go#Percent', to: 'code.symbol:a.go#Apply', scored: false },
    ];
    const match = matchEdges(edges, [{ relation: 'code.calls', from: 'k1', to: 'k2' }], nodes.recordToEntry);
    expect([...match.scopedApart.entries()]).toEqual([['remote', 1]]);
    expect(match.unscored).toBe(1);
    expect(match.missing.size).toBe(0);
    expect(match.extra.size).toBe(1);
  });
});

describe('readScoring', () => {
  test('a SCORING.md says which names are scored for recall and whether they are scored at all', () => {
    const scoring = readScoring([
      '# which names',
      '| name | recall | scored | why |',
      '| --- | --- | --- | --- |',
      '| `code.symbol` | yes | yes | |',
      '| code.expression | no | no | a mention is an extraction reading |',
      '| code.carries | yes | yes | |',
      '',
      'prose is ignored',
    ].join('\n'));
    expect(scoring.get('code.symbol')).toEqual({ recall: true, scored: true });
    expect(scoring.get('code.expression')).toEqual({ recall: false, scored: false, why: 'a mention is an extraction reading' });
    expect(scoring.size).toBe(3);
  });

  test('a file without a table says nothing, and an unmentioned name is scored as usual', () => {
    expect(readScoring('no table here').size).toBe(0);
    expect(readScoring('| name | recall |\n| --- | --- |\n| code.symbol | yes |').get('code.file')).toBeUndefined();
  });
});
