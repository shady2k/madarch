/**
 * The entity catalog a product's kinds manifest holds (decision 0033, items 8
 * to 10): every kind of the product's life cycle in two levels — an area, its
 * subgroups, the kinds — with what a kind is, the standard or document it was
 * taken from, the ways it can be acquired, whether the engine can make one yet,
 * the relations it may carry and its template policy.
 *
 * The catalog is a section of `madarch/kinds.yaml` beside the kinds' pages: the
 * `catalog:` mapping declares the schema, and every kind of `kinds:` declares
 * its own row. The engine holds no area, kind or id: this module reads the
 * schema of whatever catalog the product holds and refuses a row that leaves a
 * field out, a subgroup above its bound, two kinds of one concept, a value the
 * catalog marks as an attribute declared as a kind, and an area, a subgroup, a
 * status, a template policy or an origin mark the manifest does not declare.
 *
 * ```yaml
 * catalog:
 *   subgroup-kind-bound: 12
 *   attributes: [version, coverage]
 *   origin-marks: [document, conversation, agent-from-graph, live-system, not-implemented]
 *   extractor-mark: extractor
 *   statuses: [implemented, partial, not-implemented]
 *   template-policies: [page, member, none]
 *   relations: { c4.uses: https://c4model.com/abstractions, refines: }
 * kinds:
 *   code.service:
 *     id: c4.container
 *     group: code.structure            # the subgroup; its area is the subgroup's parent
 *     definition: A deployable part of the system.
 *     sources: [https://c4model.com/abstractions]
 *     acquisition: [extractor operations]
 *     status: implemented
 *     relation-constraints: { out: [c4.uses], in: [c4.contains] }
 *     template-policy: page
 * ```
 *
 * A relation named without a value is a plain verb no standard names; a
 * relation with a URL is a name the standard at that address defines.
 */

/** One problem the catalog reader finds: the file, the line, and the words a person reads. */
export interface CatalogFinding {
  file: string;
  line: number;
  message: string;
}

/** The schema a catalog declares about itself (`catalog:` of the manifest); every rule below reads it, none is in the engine. */
export interface CatalogSchema {
  /** The most kinds one subgroup holds (decision 0033, item 8: "about 12"). */
  readonly subgroupKindBound: number;
  /** The values the catalog marks as attributes of a kind rather than kinds of their own (item 8). */
  readonly attributes: readonly string[];
  /** The marks of how a kind comes to be, besides an extractor's (item 10). */
  readonly originMarks: readonly string[];
  /** The mark an extractor's own id follows: `extractor code`. */
  readonly extractorMark: string;
  /** The implementation statuses a kind can declare (item 8). */
  readonly statuses: readonly string[];
  /** The template policies a kind can declare: a page of its own, a member's row, or none. */
  readonly templatePolicies: readonly string[];
  /** The relation names the catalog knows, each with the address of the standard that defines it, or none for a plain verb. */
  readonly relations: ReadonlyMap<string, string | undefined>;
  /** The line the `catalog:` mapping stands at. */
  readonly line: number;
}

/** A kind's name in one interface language, as its catalog row carries it for the catalogue page. */
interface CatalogLabel {
  readonly one: string;
  readonly many: string;
}

/** One kind's catalog row: what it is, where it was taken from, how it is acquired, and where it stands. */
export interface CatalogEntry {
  readonly name: string;
  /** The canonical concept id: one concept has one kind, wherever its name is used. */
  readonly id: string;
  /** The area the kind's subgroup belongs to (the subgroup's parent). */
  readonly area: string;
  readonly subgroup: string;
  readonly definition: string;
  /** The addresses of the standards or documents the kind was taken from. */
  readonly sources: readonly string[];
  /** How the kind can be acquired: `extractor <id>` or one of the catalog's origin marks. */
  readonly acquisition: readonly string[];
  readonly status: string;
  readonly relationsOut: readonly string[];
  readonly relationsIn: readonly string[];
  readonly templatePolicy: string;
  /**
   * The kind's name per interface language, as its declaration writes it. A language the declaration leaves out is a
   * finding of its own and stays absent here: the catalog keeps the kind and the catalogue page marks its name untranslated
   * rather than showing an English one to a reader of another language (madarch-8bdc.2.5).
   */
  readonly labels: Readonly<Record<string, CatalogLabel>>;
  /** What the kind is per interface language, from the declaration's `description`; absent where a language is missing. */
  readonly descriptions: Readonly<Record<string, string>>;
  readonly line: number;
}

/** A group as the manifest declares it, for the catalog's two-level shape. */
export interface CatalogGroup {
  readonly name: string;
  readonly parent?: string;
  readonly line: number;
}

/** Every field of a catalog row, in the order a manifest writes them. `group` is the wiki's own field and is not listed. */
const CATALOG_KIND_FIELDS = ['id', 'definition', 'sources', 'acquisition', 'status', 'relation-constraints', 'template-policy'] as const;

/** The fields a kind declares only when the manifest holds a catalog: a kind that writes one of them without one is a finding. */
export const CATALOG_ONLY_FIELDS: ReadonlySet<string> = new Set(CATALOG_KIND_FIELDS);

/** Whether a source is an address a person can open: an http or https URL with a host. */
function readableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value === '') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
}

/** A list of non-empty strings, without repeats, in the order it was written. */
function distinctStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.trim() !== entry) return undefined;
    if (seen.has(entry)) return undefined;
    seen.add(entry);
  }
  return value as string[];
}

/** One identifier: no whitespace, written as it is read. */
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.trim() === value && !/\s/.test(value);

/** The last segment of a dotted name: `code.service` reads as `service`. */
const lastSegment = (value: string): string => value.slice(value.lastIndexOf('.') + 1);

/**
 * Reads the `catalog:` schema of a manifest; absent when the manifest declares none, which keeps
 * every manifest written before the catalog reading as it did.
 */
export function readCatalogSchema(value: unknown, at: (path: (string | number)[]) => number, file: string): { schema?: CatalogSchema; findings: CatalogFinding[] } {
  const findings: CatalogFinding[] = [];
  const problem = (path: (string | number)[], message: string): void => {
    const written = path.length === 0 || (value !== null && typeof value === 'object' && String(path[0]) in (value as object));
    findings.push({ file, line: written ? at(['catalog', ...path]) : at(['catalog']), message });
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problem([], '"catalog" declares the schema of the entity catalog: subgroup-kind-bound, attributes, origin-marks, extractor-mark, statuses, template-policies and relations');
    return { findings };
  }
  const body = value as Record<string, unknown>;
  const known = new Set(['subgroup-kind-bound', 'attributes', 'origin-marks', 'extractor-mark', 'statuses', 'template-policies', 'relations']);
  for (const key of Object.keys(body)) if (!known.has(key)) problem([key], `"${key}" is not a field of the catalog: the fields are ${[...known].join(', ')}`);
  const before = findings.length;
  const bound = body['subgroup-kind-bound'];
  if (typeof bound !== 'number' || !Number.isInteger(bound) || bound <= 0) problem(['subgroup-kind-bound'], `"subgroup-kind-bound" is the most kinds one subgroup holds, a whole number above zero, got ${JSON.stringify(bound)}`);
  const attributes = distinctStrings(body['attributes']);
  if (attributes === undefined) problem(['attributes'], '"attributes" is a list of the values the catalog marks as attributes of a kind rather than kinds, such as "version" or "coverage"');
  const originMarks = distinctStrings(body['origin-marks']);
  if (originMarks === undefined) problem(['origin-marks'], '"origin-marks" is a list of the ways a kind comes to be besides an extractor, such as "document" or "conversation"');
  const extractorMark = body['extractor-mark'];
  if (!isIdentifier(extractorMark)) problem(['extractor-mark'], `"extractor-mark" is the mark an extractor's id follows ("extractor code"), got ${JSON.stringify(extractorMark)}`);
  else if ((originMarks ?? []).includes(extractorMark)) problem(['extractor-mark'], `"extractor-mark" is ${JSON.stringify(extractorMark)}, and "origin-marks" declares it as a mark of its own: an extractor's mark is followed by its id`);
  const statuses = distinctStrings(body['statuses']);
  if (statuses === undefined) problem(['statuses'], '"statuses" is a list of the implementation statuses a kind declares, such as "implemented" and "not-implemented"');
  const templatePolicies = distinctStrings(body['template-policies']);
  if (templatePolicies === undefined) problem(['template-policies'], '"template-policies" is a list of the template policies a kind declares, such as "page", "member" and "none"');
  const relations = new Map<string, string | undefined>();
  const rawRelations = body['relations'];
  if (rawRelations === null || typeof rawRelations !== 'object' || Array.isArray(rawRelations)) {
    problem(['relations'], '"relations" maps each relation name the catalog uses to the address of the standard that defines it, or to nothing for a plain verb');
  } else {
    for (const [name, source] of Object.entries(rawRelations as Record<string, unknown>)) {
      if (!isIdentifier(name)) { problem(['relations', name], `relation ${JSON.stringify(name)}: a relation name is a word, such as "c4.uses"`); continue; }
      if (source === null || source === undefined || source === '') { relations.set(name, undefined); continue; }
      if (!readableUrl(source)) { problem(['relations', name], `relation "${name}": the source is the address of the standard that defines it, such as "https://c4model.com/abstractions", or nothing for a plain verb, got ${JSON.stringify(source)}`); continue; }
      relations.set(name, source);
    }
  }
  if (findings.length > before) return { findings };
  return {
    schema: {
      subgroupKindBound: bound as number,
      attributes: attributes!,
      originMarks: originMarks!,
      extractorMark: extractorMark as string,
      statuses: statuses!,
      templatePolicies: templatePolicies!,
      relations,
      line: at(['catalog']),
    },
    findings,
  };
}

/** The ways a kind's row can be acquired, as the schema allows them: `extractor <id>`, or a declared mark. */
function acquisitionMark(value: string, schema: CatalogSchema): boolean {
  if (schema.originMarks.includes(value)) return true;
  const prefix = `${schema.extractorMark} `;
  return value.startsWith(prefix) && isIdentifier(value.slice(prefix.length));
}

/**
 * The words the catalogue shows of a kind: its name in every interface language and a sentence saying what it is. A
 * language the declaration leaves out is a finding, and the kind is kept with the words it has: the catalogue lists
 * every kind the product declares, and a reader of a language without a translation sees the kind's own key marked as
 * untranslated, never an English name in its place (madarch-8bdc.2.5).
 */
function readCatalogWords(
  decl: Record<string, unknown>,
  languages: readonly string[],
  problem: (path: (string | number)[], message: string) => void,
): { labels: Record<string, CatalogLabel>; descriptions: Record<string, string> } {
  const labels: Record<string, CatalogLabel> = {};
  const rawLabels = decl['labels'];
  if (rawLabels === null || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
    problem(['labels'], `"labels" names the kind in each interface language (${languages.join(', ')}): the words one entity and several are called by`);
  } else {
    for (const [language, value] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (!languages.includes(language)) { problem(['labels', language], `"${language}" is not a language of the wiki: the languages are ${languages.join(', ')}`); continue; }
      const word = value as Record<string, unknown> | null;
      if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof word!['one'] !== 'string' || word!['one'].trim() === '' || typeof word!['many'] !== 'string' || word!['many'].trim() === '') {
        problem(['labels', language], 'a label is { one: <the name of one>, many: <the name of several> }');
        continue;
      }
      labels[language] = { one: word!['one'] as string, many: word!['many'] as string };
    }
    for (const language of languages) {
      if (labels[language] !== undefined || Object.hasOwn(rawLabels as Record<string, unknown>, language)) continue;
      problem(['labels'], `the kind has no name in "${language}": the catalogue names every kind in ${languages.join(' and ')}, and an untranslated name is never shown as an English one`);
    }
  }
  const descriptions: Record<string, string> = {};
  const rawDescription = decl['description'];
  if (rawDescription === null || typeof rawDescription !== 'object' || Array.isArray(rawDescription)) {
    problem(['description'], `"description" says what the kind is in each interface language (${languages.join(', ')}): a sentence saying what the kind is`);
  } else {
    for (const [language, text] of Object.entries(rawDescription as Record<string, unknown>)) {
      if (!languages.includes(language)) { problem(['description', language], `"${language}" is not a language of the wiki: the languages are ${languages.join(', ')}`); continue; }
      if (typeof text !== 'string' || text.trim() === '' || text.trim() !== text) { problem(['description', language], 'a description is a sentence'); continue; }
      descriptions[language] = text;
    }
    for (const language of languages) {
      if (descriptions[language] !== undefined || Object.hasOwn(rawDescription as Record<string, unknown>, language)) continue;
      problem(['description'], `the kind has no description in "${language}": the catalogue describes every kind in ${languages.join(' and ')}, and an untranslated description is never shown as an English one`);
    }
  }
  return { labels, descriptions };
}

/**
 * Reads one kind's catalog row. `problem` is the caller's finding, which names the file, the line and the kind;
 * a row with a problem returns nothing, so the kind is left out of the catalog and the rest still stand.
 */
export function readCatalogKind(
  name: string,
  decl: Record<string, unknown>,
  schema: CatalogSchema,
  groups: ReadonlyMap<string, CatalogGroup>,
  line: number,
  problem: (path: (string | number)[], message: string) => void,
  /** The languages the wiki's interface speaks: a kind names and describes itself in each, or the catalogue says why. */
  languages: readonly string[],
  /** The groups the manifest reader already refused (a `parent` nobody declares): the kind adds no second finding. */
  refusedGroups: ReadonlySet<string> = new Set(),
): CatalogEntry | undefined {
  let sound = true;
  const fail = (path: (string | number)[], message: string): void => {
    sound = false;
    problem(path, message);
  };
  const id = decl['id'];
  const words = readCatalogWords(decl, languages, problem);
  if (!isIdentifier(id)) fail(['id'], `"id" is the canonical concept id of the kind (one concept has one kind), such as "c4.container", got ${JSON.stringify(id)}`);
  const definition = decl['definition'];
  if (typeof definition !== 'string' || definition.trim() === '' || definition.trim() !== definition) fail(['definition'], `"definition" is one sentence saying what the kind is, got ${JSON.stringify(definition)}`);
  const sources = decl['sources'];
  if (!Array.isArray(sources) || sources.length === 0) fail(['sources'], '"sources" is a list of the addresses of the standards or documents the kind was taken from, so a person can read them');
  else for (const [index, source] of sources.entries()) if (!readableUrl(source)) fail(['sources', index], `"sources" holds ${JSON.stringify(source)}, which is not an http or https address: the standard or document is linked so a person can read it`);
  const acquisition = decl['acquisition'];
  const marks = distinctStrings(acquisition);
  if (marks === undefined) fail(['acquisition'], `"acquisition" is a list of the ways the kind comes to be: "${schema.extractorMark} <id>" or one of ${schema.originMarks.join(', ')}`);
  else for (const [index, mark] of marks.entries()) if (!acquisitionMark(mark, schema)) fail(['acquisition', index], `"acquisition" holds ${JSON.stringify(mark)}, which is not an acquisition of this catalog: "${schema.extractorMark} <id>" or one of ${schema.originMarks.join(', ')}`);
  const status = decl['status'];
  if (typeof status !== 'string' || !schema.statuses.includes(status)) fail(['status'], `"status" is one of ${schema.statuses.join(', ')}, got ${JSON.stringify(status)}`);
  const policy = decl['template-policy'];
  if (typeof policy !== 'string' || !schema.templatePolicies.includes(policy)) fail(['template-policy'], `"template-policy" is one of ${schema.templatePolicies.join(', ')}, got ${JSON.stringify(policy)}`);
  const subgroupName = decl['group'];
  let subgroup: CatalogGroup | undefined;
  if (typeof subgroupName !== 'string' || subgroupName.trim() === '') fail(['group'], '"group" names the subgroup of the catalog the kind belongs to');
  else {
    subgroup = groups.get(subgroupName);
    if (subgroup === undefined) fail(['group'], `"group" names the subgroup of the catalog the kind belongs to, and "groups" declares no ${JSON.stringify(subgroupName)}`);
    else if (refusedGroups.has(subgroupName)) { /* the group's own finding names the refused parent; the kind repeats nothing */ }
    else if (subgroup.parent === undefined) fail(['group'], `"group" names ${JSON.stringify(subgroupName)}, which no area holds: a catalog kind belongs to a subgroup, and a subgroup's "parent" names its area`);
    else if (!groups.has(subgroup.parent)) fail(['group'], `"group" names ${JSON.stringify(subgroupName)}, whose area ${JSON.stringify(subgroup.parent)} "groups" does not declare`);
  }
  const rawConstraints = decl['relation-constraints'];
  const out: string[] = [];
  const into: string[] = [];
  if (rawConstraints === null || typeof rawConstraints !== 'object' || Array.isArray(rawConstraints)) {
    fail(['relation-constraints'], '"relation-constraints" is { out: [<relation>, ...], in: [<relation>, ...] }: the relations the kind may carry, out and in');
  } else {
    const body = rawConstraints as Record<string, unknown>;
    for (const key of Object.keys(body)) if (key !== 'out' && key !== 'in') fail(['relation-constraints', key], `"${key}" is not a field of "relation-constraints": the fields are out and in`);
    for (const [field, into2] of [['out', out], ['in', into]] as const) {
      const list = body[field];
      if (list === undefined) { fail(['relation-constraints', field], `"relation-constraints" names "${field}", the relations the kind may carry in that direction, as a list (empty when it carries none)`); continue; }
      if (!Array.isArray(list)) { fail(['relation-constraints', field], `"${field}" is a list of the catalog's relations, empty when the kind carries none`); continue; }
      for (const [index, relation] of list.entries()) {
        if (typeof relation !== 'string' || !schema.relations.has(relation)) { fail(['relation-constraints', field, index], `the relation ${JSON.stringify(relation)} is not one of the catalog's relations (${[...schema.relations.keys()].join(', ')}): "catalog.relations" declares every relation name the catalog uses`); continue; }
        into2.push(relation);
      }
    }
  }
  if (!sound || subgroup === undefined || typeof id !== 'string') return undefined;
  return {
    name,
    id,
    area: subgroup.parent as string,
    subgroup: subgroup.name,
    definition: definition as string,
    sources: sources as string[],
    acquisition: marks!,
    status: status as string,
    relationsOut: out,
    relationsIn: into,
    templatePolicy: policy as string,
    labels: words.labels,
    descriptions: words.descriptions,
    line,
  };
}

/**
 * The findings of the catalog as a whole: a subgroup above its bound, a subgroup or an area no kind stands in,
 * two kinds of one concept id, and a value the catalog marks as an attribute declared as a kind.
 */
export function catalogFindings(
  schema: CatalogSchema,
  groups: ReadonlyMap<string, CatalogGroup>,
  entries: ReadonlyMap<string, CatalogEntry>,
  file: string,
): CatalogFinding[] {
  const findings: CatalogFinding[] = [];
  const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  const subgroups = [...groups.values()].filter((group) => group.parent !== undefined).sort((left, right) => order(left.name, right.name));
  const bySubgroup = new Map<string, string[]>();
  for (const entry of entries.values()) {
    const held = bySubgroup.get(entry.subgroup) ?? [];
    held.push(entry.name);
    bySubgroup.set(entry.subgroup, held);
  }
  // A group the catalog does not fill is the product's own business — a product may declare a group for the kinds it
  // will hold later — so the check refuses only a subgroup above its bound, and no invented gap.
  for (const subgroup of subgroups) {
    const held = (bySubgroup.get(subgroup.name) ?? []).sort(order);
    if (held.length > schema.subgroupKindBound) findings.push({ file, line: subgroup.line, message: `subgroup "${subgroup.name}": ${held.length} kinds (${held.join(', ')}), above the bound of ${schema.subgroupKindBound} a subgroup holds ("catalog: subgroup-kind-bound")` });
  }
  const concepts = new Map<string, string>();
  for (const entry of entries.values()) {
    const first = concepts.get(entry.id);
    if (first !== undefined) { findings.push({ file, line: entry.line, message: `kind "${entry.name}": the concept id "${entry.id}" is the id of kind "${first}", and one concept has one kind: the kind a second area shares stands in one subgroup, and the other refers to it` }); continue; }
    concepts.set(entry.id, entry.name);
  }
  const attributes = new Set(schema.attributes);
  for (const entry of entries.values()) {
    const attribute = [entry.id, lastSegment(entry.id), lastSegment(entry.name)].find((value) => attributes.has(value));
    if (attribute !== undefined) findings.push({ file, line: entry.line, message: `kind "${entry.name}": "${attribute}" is a value the catalog marks as an attribute ("catalog.attributes"), not a kind` });
  }
  return findings;
}
