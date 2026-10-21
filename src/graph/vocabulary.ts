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

/** The store's own knowledge mechanics: content, claims, evidence, acceptance, questions, states. */
export const ENGINE_PREFIX = 'engine:';
/** The extractor schema: code structure, history, configuration, data model, contracts. */
export const CODE_PREFIX = 'code.';

/** The store's own node kinds (knowledge mechanics only). */
export const ENGINE_NODE_KINDS = [
  'engine:acceptance',
  'engine:answer',
  'engine:claim',
  'engine:content',
  'engine:evidence',
  'engine:question',
  'engine:state',
] as const;

/** The extractor schema's node kinds the store knows from the start; a driver registers the rest from what extractors emit. */
export const CODE_NODE_KINDS = ['code.commit', 'code.directory', 'code.file', 'code.repository', 'code.symbol'] as const;

export interface RelationDeclaration {
  key: string;
  /** Parallel relations of this type are meaningful, so an edge may carry a non-empty discriminator. */
  discriminated?: boolean;
  /** An edge of this type carries a byte position (an occurrence). */
  positioned?: boolean;
}

/** The store's own relation types (knowledge mechanics only). */
export const ENGINE_RELATIONS: readonly RelationDeclaration[] = [
  { key: 'engine:answers' },
  { key: 'engine:contradicts' },
  { key: 'engine:evidence-of' },
  { key: 'engine:state-after' },
  { key: 'engine:subject-of' },
  { key: 'engine:supports' },
];

/** The extractor schema's relation types known from the start. `code.occurrence` is the positioned one. */
export const CODE_RELATIONS: readonly RelationDeclaration[] = [
  { key: 'code.calls' },
  { key: 'code.contains' },
  { key: 'code.imports' },
  { key: 'code.inherits' },
  { key: 'code.links-content' },
  { key: 'code.occurrence', positioned: true },
];

/** True when a key belongs to the engine's namespaces (`engine:` or `code.`). */
export function isEngineKey(key: string): boolean {
  return key.startsWith(ENGINE_PREFIX) || key.startsWith(CODE_PREFIX);
}

/** The relation types the store itself reads: calls and containment. */
export const CALLS = 'code.calls';
export const CONTAINS = 'code.contains';
export const STATE_AFTER = 'engine:state-after';
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
    if (isEngineKey(key)) {
      throw new GraphError('register vocabulary', path, `"${key}" uses the prefix "${ENGINE_PREFIX}" or "${CODE_PREFIX}", which belong to the engine's own vocabulary; a product key may use neither`, registry.origin);
    }
    if (seen.has(key)) throw new GraphError('register vocabulary', path, `"${key}" is registered twice in one registry (a kind and a relation type share no key either)`, registry.origin);
    seen.add(key);
  };
  registry.kinds.forEach((key, index) => check(key, `kinds[${index}]`));
  seen.clear();
  registry.relations.forEach((relation, index) => check(relation.key, `relations[${index}].key`));
}

/** Refuses an extractor schema that is malformed or whose keys do not start with `code.`. */
export function checkCodeSchema(schema: GraphRegistry): void {
  const seen = new Set<string>();
  const check = (key: string, path: string): void => {
    if (typeof key !== 'string' || !key.startsWith(CODE_PREFIX) || key === CODE_PREFIX || key !== key.trim()) {
      throw new GraphError('register code schema', path, `an extractor schema key starts with "${CODE_PREFIX}" and has a name after it, got ${JSON.stringify(key)}`, schema.origin);
    }
    if (seen.has(key)) throw new GraphError('register code schema', path, `"${key}" is declared twice`, schema.origin);
    seen.add(key);
  };
  schema.kinds.forEach((key, index) => check(key, `kinds[${index}]`));
  seen.clear();
  schema.relations.forEach((relation, index) => check(relation.key, `relations[${index}].key`));
}
