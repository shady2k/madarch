/**
 * The catalog's vocabulary as the comparison's language
 * (`scripts/reference-graph-catalog.ts`): a reference may state a catalog kind or
 * relation where the graph names the extractor's, and the mapping in
 * `src/knowledge/starter-mapping.ts` is the data that ties them. Fixtures only: a
 * reference entry named in the catalog's words and a graph record named in the
 * extractor's, matched through the same place rule the scorer uses.
 */
import { describe, expect, test } from 'bun:test';
import { catalogEdgeOf, catalogKindOf, catalogNameOf, catalogRelationOf } from '../scripts/reference-graph-catalog.js';
import { matchEdges, matchNodes, type NodeRecord, type ReferenceEdge, type ReferenceEntry } from '../scripts/reference-graph-by-place.js';

function entry(id: string, kind: string, path: string, line: number): ReferenceEntry {
  return { id, kind, evidence: [{ path, startLine: line, endLine: line }] };
}

function record(key: string, kind: string, path: string, line: number): NodeRecord {
  return { key, kind, place: { path, startLine: line, endLine: line } };
}

describe('the mapping resolves a key', () => {
  test('a kind resolves to its catalog kind, and a key without a row stays as written', () => {
    expect(catalogKindOf('code.document')).toBe('document');
    expect(catalogKindOf('code.test')).toBe('code.test-case');
    expect(catalogKindOf('code.state')).toBe('state');
    expect(catalogKindOf('code.symbol')).toBe('code.symbol');
    expect(catalogKindOf('document')).toBe('document');
    expect(catalogKindOf('code.expression')).toBe('code.expression');
  });

  test('a relation resolves to its catalog relation, and several extractor keys name one', () => {
    expect(catalogRelationOf('code.contains')).toBe('contains');
    expect(catalogRelationOf('code.calls')).toBe('uses');
    expect(catalogRelationOf('code.uses-type')).toBe('uses');
    // A declared library is what a code file depends on: the dependency kind's own relation is
    // dependsOn, and `uses` is a plain verb no standard names.
    expect(catalogRelationOf('code.uses-dependency')).toBe('dependsOn');
    expect(catalogRelationOf('code.depends-on')).toBe('dependsOn');
    expect(catalogRelationOf('code.imports')).toBe('dependsOn');
    expect(catalogRelationOf('code.mentions')).toBe('code.mentions');
    expect(catalogRelationOf('contains')).toBe('contains');
    expect(catalogNameOf('code.document')).toBe('document');
    expect(catalogNameOf('code.belongs-to')).toBe('partOf');
  });

  test('an inverse row swaps the edge ends, and a row without a catalog target does not', () => {
    expect(catalogEdgeOf('code.contains', 'a', 'b')).toEqual({ relation: 'contains', from: 'a', to: 'b' });
    expect(catalogEdgeOf('code.built-by', 'image', 'dockerfile')).toEqual({ relation: 'generates', from: 'dockerfile', to: 'image' });
    expect(catalogEdgeOf('code.served-by', 'route', 'handler')).toEqual({ relation: 'handles', from: 'handler', to: 'route' });
    expect(catalogEdgeOf('code.mentions', 'a', 'b')).toEqual({ relation: 'code.mentions', from: 'a', to: 'b' });
  });
});

describe('a catalog-named reference matches an extractor-named graph', () => {
  test('a node named `document` finds a record named `code.document`', () => {
    const reference = [{ ...entry('document:README.md', catalogKindOf('document'), 'README.md', 1) }];
    const graph = [record('k1', catalogKindOf('code.document'), 'README.md', 1)];
    const match = matchNodes(reference, graph);
    expect(match.entryToRecord.get('document:README.md')).toBe('k1');
  });

  test('a node named `code.test-case` finds a record named `code.test`', () => {
    const reference = [{ ...entry('code.test-case:a.go#TestX', catalogKindOf('code.test-case'), 'a.go', 9) }];
    const graph = [record('k1', catalogKindOf('code.test'), 'a.go', 9)];
    expect(matchNodes(reference, graph).entryToRecord.get('code.test-case:a.go#TestX')).toBe('k1');
  });

  test('a catalog relation matches the extractor relation, and an inverse one matches with its ends swapped', () => {
    const nodes = matchNodes(
      [entry('a', catalogKindOf('code.file'), 'a.go', 1), entry('b', catalogKindOf('code.file'), 'b.go', 1)],
      [record('ka', catalogKindOf('code.file'), 'a.go', 1), record('kb', catalogKindOf('code.file'), 'b.go', 1)],
    );
    const direct: ReferenceEdge[] = [{ relation: catalogRelationOf('contains'), from: 'a', to: 'b' }];
    const matched = matchEdges(direct, [{ relation: catalogRelationOf('code.contains'), from: 'ka', to: 'kb' }], nodes.recordToEntry);
    expect(matched.matched.size).toBe(1);
    expect(matched.missing.size).toBe(0);

    const inverse: ReferenceEdge[] = [{ relation: catalogRelationOf('generates'), from: 'a', to: 'b' }];
    const swapped = catalogEdgeOf('code.built-by', 'kb', 'ka');
    const inverseMatch = matchEdges(inverse, [{ relation: swapped.relation, from: swapped.from, to: swapped.to }], nodes.recordToEntry);
    expect(inverseMatch.matched.size).toBe(1);
    expect(inverseMatch.missing.size).toBe(0);
  });

  test('two extractor relations with one catalog name are one relation in the comparison', () => {
    expect(catalogRelationOf('code.calls')).toBe(catalogRelationOf('code.uses-type'));
    const nodes = matchNodes(
      [entry('a', catalogKindOf('code.symbol'), 'a.go', 1), entry('b', catalogKindOf('code.symbol'), 'b.go', 1)],
      [record('ka', catalogKindOf('code.symbol'), 'a.go', 1), record('kb', catalogKindOf('code.symbol'), 'b.go', 1)],
    );
    const reference: ReferenceEdge[] = [{ relation: catalogRelationOf('code.calls'), from: 'a', to: 'b' }];
    const graph = [{ relation: catalogRelationOf('code.uses-type'), from: 'ka', to: 'kb' }];
    expect(matchEdges(reference, graph, nodes.recordToEntry).matched.size).toBe(1);
  });
});
