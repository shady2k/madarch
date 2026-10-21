/**
 * The graph's vocabulary (decision 0028, "Tables"; decision 0026). Two
 * namespaces share `node_kind` and `relation_type`:
 *
 * - the engine's own: the deterministic extractors' code-structure schema and
 *   the mechanics the store itself implements (content, claims, acceptance,
 *   the architecture-state chain), every key under `ENGINE_PREFIX`;
 * - the product's: kinds and relation types a caller's registry passes in.
 *   The engine declares none of them, and a product key may not use the
 *   engine's prefix.
 */
import { GraphError } from './errors.js';

/** Every engine key starts with this prefix; no product key may. */
export const ENGINE_PREFIX = 'engine:';

/** The engine's node kinds: extractor schema (file, directory, symbol, commit) and store mechanics. */
export const ENGINE_NODE_KINDS = [
  'engine:acceptance',
  'engine:answer',
  'engine:claim',
  'engine:commit',
  'engine:content',
  'engine:directory',
  'engine:evidence',
  'engine:file',
  'engine:question',
  'engine:state',
  'engine:symbol',
] as const;

export interface RelationDeclaration {
  key: string;
  /** Parallel relations of this type are meaningful, so an edge may carry a non-empty discriminator. */
  discriminated?: boolean;
  /** An edge of this type carries a byte position (an occurrence). */
  positioned?: boolean;
}

/** The engine's relation types. `engine:occurrence` is the positioned one; no other engine type is discriminated. */
export const ENGINE_RELATIONS: readonly RelationDeclaration[] = [
  { key: 'engine:after' },
  { key: 'engine:answers' },
  { key: 'engine:calls' },
  { key: 'engine:contains' },
  { key: 'engine:contradicts' },
  { key: 'engine:evidence-of' },
  { key: 'engine:imports' },
  { key: 'engine:inherits' },
  { key: 'engine:links-content' },
  { key: 'engine:occurrence', positioned: true },
  { key: 'engine:subject-of' },
  { key: 'engine:supports' },
];

/** The relation types the store itself reads: calls and containment. */
export const CALLS = 'engine:calls';
export const CONTAINS = 'engine:contains';
export const STATE_KIND = 'engine:state';
export const CONTENT_KIND = 'engine:content';
export const CLAIM_KIND = 'engine:claim';
export const ACCEPTANCE_KIND = 'engine:acceptance';

/** What a product's registry passes to the store: its kinds and relation types, by key. */
export interface GraphRegistry {
  kinds: readonly string[];
  relations: readonly RelationDeclaration[];
  /** Where the registry came from, for refusals. */
  origin?: { file: string; line?: number };
}

/** Refuses a registry that is malformed or that claims the engine's namespace; names the entry's path. */
export function checkRegistry(registry: GraphRegistry): void {
  const seen = new Set<string>();
  const check = (key: string, path: string): void => {
    if (typeof key !== 'string' || key.trim() === '' || key !== key.trim()) {
      throw new GraphError('register vocabulary', path, `a vocabulary key is a non-empty text without surrounding blanks, got ${JSON.stringify(key)}`, registry.origin);
    }
    if (key.startsWith(ENGINE_PREFIX)) {
      throw new GraphError('register vocabulary', path, `"${key}" uses the prefix "${ENGINE_PREFIX}", which belongs to the engine's own vocabulary; a product key may not`, registry.origin);
    }
    if (seen.has(key)) throw new GraphError('register vocabulary', path, `"${key}" is registered twice in one registry (a kind and a relation type share no key either)`, registry.origin);
    seen.add(key);
  };
  registry.kinds.forEach((key, index) => check(key, `kinds[${index}]`));
  seen.clear();
  registry.relations.forEach((relation, index) => check(relation.key, `relations[${index}].key`));
}
