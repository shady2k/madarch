/**
 * The catalog's vocabulary, as the comparison's language.
 *
 * A reference may state a catalog kind or relation where the graph names the
 * extractor's; the mapping in `src/knowledge/starter-mapping.ts` is the data
 * that ties the two. This module resolves a key through that mapping:
 *
 * - a kind key resolves to its catalog kind (`code.document` → `document`,
 *   `code.test` → `code.test-case`);
 * - a relation key resolves to its catalog relation, and a row whose direction
 *   is `inverse` swaps the edge's ends (`code.built-by` from A to B is the
 *   catalog's `generates` from B to A);
 * - a key without a row — an internal key of the producers, or a name that is
 *   already the catalog's — is compared as written.
 *
 * Nothing here is a list of names: the rows are read from the mapping, so a key
 * the mapping starts tying is resolved without a change here.
 */
import { MAPPING_KIND_ROWS, MAPPING_RELATION_ROWS } from '../src/knowledge/starter-mapping.js';

/** One kind's tie: the extractor's key and the catalog's kind. */
export interface KindMapping {
  readonly extractor: string;
  readonly catalog: string;
}

/** One relation's tie: the extractor's key, the catalog's relation, and the direction. */
export interface RelationMapping {
  readonly extractor: string;
  readonly catalog: string;
  readonly direction: 'same' | 'inverse';
}

const KIND_ROWS: ReadonlyMap<string, KindMapping> = new Map(
  MAPPING_KIND_ROWS.filter((row) => row.kind !== undefined).map((row) => [row.key, { extractor: row.key, catalog: row.kind! }]),
);

const RELATION_ROWS: ReadonlyMap<string, RelationMapping> = new Map(
  MAPPING_RELATION_ROWS.filter((row) => row.relation !== undefined).map((row) => [
    row.key,
    { extractor: row.key, catalog: row.relation!, direction: row.direction === 'inverse' ? 'inverse' : 'same' },
  ]),
);

/** The catalog kind a key names, or the key itself when the mapping holds no row for it. */
export function catalogKindOf(kind: string): string {
  return KIND_ROWS.get(kind)?.catalog ?? kind;
}

/** The catalog relation a key names, or the key itself when the mapping holds no row for it. */
export function catalogRelationOf(relation: string): string {
  return RELATION_ROWS.get(relation)?.catalog ?? relation;
}

/**
 * A name of either namespace in the catalog's vocabulary: a kind first (a kind
 * and a relation never share a key), then a relation, then the name as written.
 */
export function catalogNameOf(name: string): string {
  return KIND_ROWS.get(name)?.catalog ?? RELATION_ROWS.get(name)?.catalog ?? name;
}

/** One edge in the catalog's vocabulary, with its ends swapped when the row is inverse. */
export interface CanonicalEdge {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
}

export function catalogEdgeOf(relation: string, from: string, to: string): CanonicalEdge {
  const held = RELATION_ROWS.get(relation);
  if (held === undefined) return { relation, from, to };
  return held.direction === 'inverse' ? { relation: held.catalog, from: to, to: from } : { relation: held.catalog, from, to };
}

/** The kind mapping a key uses, where the mapping holds one. */
export function kindMappingOf(kind: string): KindMapping | undefined {
  return KIND_ROWS.get(kind);
}

/** The relation mapping a key uses, where the mapping holds one. */
export function relationMappingOf(relation: string): RelationMapping | undefined {
  return RELATION_ROWS.get(relation);
}
