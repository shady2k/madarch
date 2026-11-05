/**
 * The extractors' vocabulary and the catalog, tied by a versioned mapping (decision 0033, item 7): the
 * extractors keep their own code-structure vocabulary, the product's kinds are the catalog's, and
 * `mapping:` in `madarch/kinds.yaml` ties every node kind and relation type the extractors emit to a catalog
 * kind or relation, or declares it internal to extraction with the reason.
 *
 * The engine holds no kind and no relation of the extractors: the emitted keys come from the extractors'
 * declared vocabulary (`src/extract/vocabulary.ts`), and the targets are the product's own catalog and its
 * relation names. The check refuses an emitted key no row ties, a row that ties it to a kind or relation the
 * catalog does not hold (naming both), a row for a key no extractor emits, and a row that is neither a tie
 * nor an internal declaration with a reason.
 *
 * ```yaml
 * mapping:
 *   version: 1
 *   kinds:
 *     code.symbol: { kind: code.symbol }
 *     code.facet: { internal: "a reading of one file, shown on the file's page" }
 *   relations:
 *     code.contains: { relation: contains }
 *     code.occurrence: { internal: "one positioned site a name is read at" }
 * ```
 */
import { EXTRACTOR_KINDS, EXTRACTOR_RELATIONS } from '../extract/vocabulary.js';
import type { CatalogFinding } from './catalog.js';
import type { CatalogEntry, CatalogSchema } from './catalog.js';

/** The versions of the mapping's shape this engine reads. */
const MAPPING_VERSIONS: readonly number[] = [1];

/**
 * The directions a tied relation can take: `same` when the extractor's edge runs the way the catalog's relation
 * runs, `inverse` when the extractor reads the edge the other way round (a route is handled by a symbol, where
 * `handles` runs from the symbol to the route).
 */
const MAPPING_DIRECTIONS = ['same', 'inverse'] as const;

/** How one extractor key is tied to the catalog. */
interface MappingRow {
  readonly key: string;
  /** `kind`: the catalog kind it is shown as; `relation`: the catalog's relation; `internal`: extraction's own. */
  readonly tie: 'kind' | 'relation' | 'internal';
  /** The catalog kind or relation name, for a tie. */
  readonly target?: string;
  /** For a relation tie, whether the extractor's edge runs the way the catalog's relation does or the other way. */
  readonly direction?: 'same' | 'inverse';
  /** The reason an internal key is not a catalog kind or relation. */
  readonly reason?: string;
  readonly line: number;
}

/** The mapping as the manifest declares it, with the findings of reading it. */
export interface MappingRead {
  readonly version: number;
  readonly kinds: ReadonlyMap<string, MappingRow>;
  readonly relations: ReadonlyMap<string, MappingRow>;
  readonly findings: CatalogFinding[];
}

/** The fields a row of the mapping holds. */
const ROW_FIELDS = ['kind', 'relation', 'internal'] as const;

/** The field a tied relation carries besides its name. */
const DIRECTION_FIELD = 'direction';

/** The keys whose list a message names, in code point order, cut to a sentence a person can read. */
function names(keys: Iterable<string>): string {
  const held = [...keys].sort();
  return held.length === 0 ? 'none' : held.join(', ');
}

/**
 * Reads the `mapping:` section of a manifest. `at` resolves a path to its line; the catalog's kinds and its
 * relation names are what a row may tie to, and the extractors' declared vocabulary is what must be tied.
 */
export function readMapping(
  value: unknown,
  at: (path: (string | number)[]) => number,
  file: string,
  catalog: { readonly schema: CatalogSchema; readonly kinds: ReadonlyMap<string, CatalogEntry> } | undefined,
  emitted: { readonly kinds: ReadonlyMap<string, readonly string[]>; readonly relations: ReadonlyMap<string, readonly string[]> } = { kinds: EXTRACTOR_KINDS, relations: EXTRACTOR_RELATIONS },
  /**
   * Every kind the manifest declares, the ones the catalog refused included: a mapping row names a kind the manifest
   * declares, and whether that kind's own row is sound is the catalog's finding — one defect, one problem.
   */
  declaredKinds?: ReadonlySet<string>,
): MappingRead {
  const findings: CatalogFinding[] = [];
  const problem = (path: (string | number)[], message: string): void => {
    const written = path.length === 0 || (value !== null && typeof value === 'object' && String(path[0]) in (value as object));
    findings.push({ file, line: written ? at(['mapping', ...path]) : at(['mapping']), message });
  };
  const nothing = (version: number): MappingRead => ({ version, kinds: new Map(), relations: new Map(), findings });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problem([], '"mapping" ties every kind and relation the extractors emit to a catalog kind or relation, or declares it internal: { version, kinds, relations }');
    return nothing(0);
  }
  const body = value as Record<string, unknown>;
  if (catalog === undefined) problem([], `"mapping" ties the extractors' vocabulary to the catalog, and the manifest declares no "catalog"`);
  for (const key of Object.keys(body)) if (key !== 'version' && key !== 'kinds' && key !== 'relations') problem([key], `"${key}" is not a field of the mapping: the fields are version, kinds and relations`);
  const version = body['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || !MAPPING_VERSIONS.includes(version)) {
    problem(['version'], `"version" is a version of the mapping this engine reads (${MAPPING_VERSIONS.join(', ')}), got ${JSON.stringify(version)}`);
  }
  const catalogKinds = catalog === undefined ? undefined : (declaredKinds ?? new Set(catalog.kinds.keys()));
  const catalogRelations = catalog === undefined ? undefined : new Set(catalog.schema.relations.keys());
  // The rows read, and every key the manifest writes a row for: a refused row is a finding of its own, and its
  // presence is what keeps the completeness pass from reporting the same key a second time as untied.
  const read = (section: 'kinds' | 'relations'): { rows: Map<string, MappingRow>; declared: ReadonlySet<string> } => {
    const held = new Map<string, MappingRow>();
    const declared = new Set<string>();
    const raw = body[section];
    if (raw === undefined) {
      problem([section], `"${section}" maps every ${section === 'kinds' ? 'node kind' : 'relation type'} the extractors emit to the catalog, or declares it internal`);
      return { rows: held, declared };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problem([section], `"${section}" maps each key the extractors emit to { ${section === 'kinds' ? 'kind' : 'relation'} } or { internal }`);
      return { rows: held, declared };
    }
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      declared.add(key);
      const line = at(['mapping', section, key]);
      const fail = (message: string): void => { findings.push({ file, line, message: `${section === 'kinds' ? 'kind' : 'relation'} "${key}": ${message}` }); };
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { fail(`the row is { ${section === 'kinds' ? 'kind' : 'relation'} } or { internal }`); continue; }
      const row = entry as Record<string, unknown>;
      for (const field of Object.keys(row)) if (!(ROW_FIELDS as readonly string[]).includes(field) && field !== DIRECTION_FIELD) fail(`"${field}" is not a field of a mapping row: the fields are ${ROW_FIELDS.join(', ')}, and a tied relation's ${DIRECTION_FIELD}`);
      const present = ROW_FIELDS.filter((field) => row[field] !== undefined);
      if (present.length !== 1) { fail(`the row names exactly one of ${ROW_FIELDS.join(', ')}, and it names ${present.length === 0 ? 'none' : present.join(' and ')}`); continue; }
      const field = present[0]!;
      // The section says which namespace the key is in: a kind's row ties to a kind and a relation's to a relation.
      const wanted = section === 'kinds' ? 'kind' : 'relation';
      if (field !== 'internal' && field !== wanted) { fail(`"${field}" is not a field of a ${wanted}'s row: a ${section === 'kinds' ? 'kind' : 'relation type'} is tied to the catalog's ${wanted}, or declared internal`); continue; }
      const target = row[field];
      // A tied relation says which way it runs; a kind's row and an internal row carry no direction.
      const rawDirection = row[DIRECTION_FIELD];
      let direction: 'same' | 'inverse' | undefined;
      if (field === 'relation') {
        if (typeof rawDirection !== 'string' || !(MAPPING_DIRECTIONS as readonly string[]).includes(rawDirection)) { fail(`"direction" is ${MAPPING_DIRECTIONS.join(' or ')}: whether the extractor's edge runs with the catalog's "${String(target)}" or against it, got ${JSON.stringify(rawDirection)}`); continue; }
        direction = rawDirection as 'same' | 'inverse';
      } else if (rawDirection !== undefined) {
        fail(field === 'internal' ? '"direction" belongs to a relation tie: an internal key names no catalog relation to run with or against' : '"direction" belongs to a relation tie: a kind is tied to a kind, which has no direction');
        continue;
      }
      if (field === 'internal') {
        if (typeof target !== 'string' || target.trim() === '') { fail('"internal" is the reason the key is extraction\'s own and not a catalog kind or relation'); continue; }
        held.set(key, { key, tie: 'internal', reason: target, line });
        continue;
      }
      if (typeof target !== 'string' || target.trim() === '') { fail(`"${field}" names a catalog ${wanted}, got ${JSON.stringify(target)}`); continue; }
      if (field === 'kind' && catalogKinds !== undefined && !catalogKinds.has(target)) {
        fail(`the mapping ties it to the kind "${target}", and the catalog holds no such kind (its kinds are ${names(catalogKinds)})`);
        continue;
      }
      if (field === 'relation' && catalogRelations !== undefined && !catalogRelations.has(target)) {
        fail(`the mapping ties it to the relation "${target}", and the catalog holds no such relation ("catalog.relations": ${names(catalogRelations)})`);
        continue;
      }
      held.set(key, { key, tie: field, target, ...(direction === undefined ? {} : { direction }), line });
    }
    return { rows: held, declared };
  };
  const kinds = read('kinds');
  const relations = read('relations');
  if (catalog === undefined) return nothing(typeof version === 'number' ? version : 0);
  // Every key the extractors declare must be tied: an extractor that starts emitting one is refused until its
  // row is written, which is what makes the mapping complete rather than a list of what somebody remembered.
  const missing = (section: 'kinds' | 'relations', emitted: ReadonlyMap<string, readonly string[]>, parsed: { rows: ReadonlyMap<string, MappingRow>; declared: ReadonlySet<string> }): void => {
    const held = parsed.rows;
    for (const [key, extractors] of emitted) {
      // A row the manifest writes and the reader refused is one problem, the row's own: its presence is not
      // "ties no row to it" as well.
      if (held.has(key) || parsed.declared.has(key)) continue;
      findings.push({
        file,
        line: at(['mapping', section]),
        message: `${section === 'kinds' ? 'kind' : 'relation'} "${key}": the extractor ${extractors.map((extractor) => `"${extractor}"`).join(' and ')} emits it, and the mapping ties no row to it: a catalog ${section === 'kinds' ? 'kind' : 'relation'} or an "internal" with the reason`,
      });
    }
    // A row for a key no extractor emits is stale: the mapping would claim a tie nothing carries.
    for (const key of held.keys()) {
      if (emitted.has(key)) continue;
      const where = held.get(key)!;
      findings.push({ file, line: where.line, message: `${section === 'kinds' ? 'kind' : 'relation'} "${key}": no extractor emits it, and the mapping names it: remove the row (the emitted ${section === 'kinds' ? 'kinds are' : 'relations are'} ${names(emitted.keys())})` });
    }
  };
  missing('kinds', emitted.kinds, kinds);
  missing('relations', emitted.relations, relations);
  return { version: typeof version === 'number' ? version : 0, kinds: kinds.rows, relations: relations.rows, findings };
}
