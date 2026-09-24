import type { ModelError } from './errors.js';
import { DEFAULT_STATE_ID, ID_PATTERN, type Category, type Element, type Environment, type Interface, type Relation, type State, type Zone } from './schema.js';
import { computeElementPresence, computeRelationPresence, type Presence } from './presence.js';
import { resolveGeneralZones, resolveZonesInEnvironment } from './zones.js';
import { segmentsToPath, type PathSegment } from './yaml-position.js';

/**
 * An element together with where it was written, kept only for the
 * duration of loading: ids, references and cycles all need to name a
 * file, a line and the item's index within its own file's section (to
 * build its full path from the model's top, `elements[3].parent`), but the
 * compiled `IntendedModel` does not carry positions.
 */
export interface PositionedElement {
  element: Element;
  file: string;
  /** This element's index within its own file's `elements` array. */
  index: number;
  line: number;
  idLine: number;
  parentLine: number;
  zonesLine: number;
  zonesAddLines: number[];
  zonesExcludeLines: number[];
  zonesReplaceLines: number[];
  environmentsLine: number;
  environmentsLines: number[];
  sinceLine: number;
  untilLine: number;
}

export interface PositionedInterface {
  iface: Interface;
  file: string;
  index: number;
  line: number;
  idLine: number;
  providerLine: number;
  contractLine: number;
}

/** The line of each transfer's `categories` entries, parallel to `relation.transfers`. */
export interface TransferLines {
  categoryLines: number[];
}

export interface PositionedRelation {
  relation: Relation;
  file: string;
  index: number;
  line: number;
  idLine: number;
  fromLine: number;
  toLine: number;
  refinesLine: number;
  interfaceLine: number;
  transferLines: TransferLines[];
  sinceLine: number;
  untilLine: number;
}

export interface PositionedCategory {
  category: Category;
  file: string;
  index: number;
  line: number;
  idLine: number;
}

export interface PositionedZone {
  zone: Zone;
  file: string;
  index: number;
  line: number;
  idLine: number;
}

/** The line of one element's zone change inside one environment's `zones` map. */
export interface EnvironmentZoneLines {
  elementId: string;
  line: number;
  addLines: number[];
  excludeLines: number[];
}

export interface PositionedEnvironment {
  environment: Environment;
  file: string;
  index: number;
  line: number;
  idLine: number;
  zonesLines: EnvironmentZoneLines[];
}

export interface PositionedState {
  state: State;
  file: string;
  index: number;
  line: number;
  idLine: number;
  afterLine: number;
}

/**
 * The string ids a file that failed its own schema check still declared,
 * kept separate from `PositionedModel` (see `checkReferences`): a mistake
 * elsewhere in that file must not make a correct reference *into* it, from
 * another file, look broken too.
 */
export interface ExtraKnownIds {
  elements: Set<string>;
  interfaces: Set<string>;
  relations: Set<string>;
  categories: Set<string>;
  zones: Set<string>;
  environments: Set<string>;
  states: Set<string>;
}

const EMPTY_EXTRA_KNOWN_IDS: ExtraKnownIds = {
  elements: new Set(),
  interfaces: new Set(),
  relations: new Set(),
  categories: new Set(),
  zones: new Set(),
  environments: new Set(),
  states: new Set(),
};

/** Builds one `ModelError`, its `path` the full path from the model's top. */
function errorAt(file: string, line: number, segments: PathSegment[], message: string): ModelError {
  return { file, line, path: segmentsToPath(segments), message };
}

export interface PositionedModel {
  elements: PositionedElement[];
  interfaces: PositionedInterface[];
  relations: PositionedRelation[];
  categories: PositionedCategory[];
  zones: PositionedZone[];
  environments: PositionedEnvironment[];
  states: PositionedState[];
}

/** An element's ancestor ids, ordered from the root down to its immediate parent. */
export type AncestorsById = ReadonlyMap<string, readonly string[]>;

/** The shape `computeAncestors` needs: just enough to walk `parent` links. */
export interface ElementParentLike {
  id: string;
  parent?: string;
}

/** The shape `computeStateOrder` needs: just enough to walk the `after` chain. */
export interface StateAfterLike {
  id: string;
  after?: string;
}

/**
 * Validates ids and references across the whole model, once every file has
 * parsed and matched the schema.
 *
 * Checks that stand alone — id syntax, duplicate ids, contract parsing, the
 * shape of a zone change, the chain of states, since/until order and every
 * reference — never wait on one another: each runs regardless of what the
 * others found, so every independent problem is reported together. Only
 * checks that need a model already free of unknown references (cycles of
 * `parent` or `refines`, a refinement's ends, zone inheritance) wait for
 * `checkReferences` to have found nothing, since walking an unresolved
 * reference would be meaningless; and the checks built on a cycle-free
 * `parent` (zone inheritance) wait, in turn, for the cycle check.
 */
export function validateModel(positioned: PositionedModel, extraKnownIds: ExtraKnownIds = EMPTY_EXTRA_KNOWN_IDS): ModelError[] {
  const errors: ModelError[] = [];

  errors.push(
    ...checkIdSyntax(positioned.elements.map((e) => ({ id: e.element.id, file: e.file, line: e.idLine, segments: ['elements', e.index, 'id'] })), 'element'),
    ...checkIdSyntax(positioned.interfaces.map((i) => ({ id: i.iface.id, file: i.file, line: i.idLine, segments: ['interfaces', i.index, 'id'] })), 'interface'),
    ...checkIdSyntax(positioned.relations.map((r) => ({ id: r.relation.id, file: r.file, line: r.idLine, segments: ['relations', r.index, 'id'] })), 'relation'),
    ...checkIdSyntax(positioned.categories.map((c) => ({ id: c.category.id, file: c.file, line: c.idLine, segments: ['categories', c.index, 'id'] })), 'category'),
    ...checkIdSyntax(positioned.zones.map((z) => ({ id: z.zone.id, file: z.file, line: z.idLine, segments: ['zones', z.index, 'id'] })), 'zone'),
    ...checkIdSyntax(positioned.environments.map((e) => ({ id: e.environment.id, file: e.file, line: e.idLine, segments: ['environments', e.index, 'id'] })), 'environment'),
    ...checkIdSyntax(positioned.states.map((s) => ({ id: s.state.id, file: s.file, line: s.idLine, segments: ['states', s.index, 'id'] })), 'state'),
  );

  errors.push(
    ...checkDuplicateIds(positioned.elements.map((e) => ({ id: e.element.id, file: e.file, line: e.idLine, segments: ['elements', e.index, 'id'] })), 'element'),
    ...checkDuplicateIds(positioned.interfaces.map((i) => ({ id: i.iface.id, file: i.file, line: i.idLine, segments: ['interfaces', i.index, 'id'] })), 'interface'),
    ...checkDuplicateIds(positioned.relations.map((r) => ({ id: r.relation.id, file: r.file, line: r.idLine, segments: ['relations', r.index, 'id'] })), 'relation'),
    ...checkDuplicateIds(positioned.categories.map((c) => ({ id: c.category.id, file: c.file, line: c.idLine, segments: ['categories', c.index, 'id'] })), 'category'),
    ...checkDuplicateIds(positioned.zones.map((z) => ({ id: z.zone.id, file: z.file, line: z.idLine, segments: ['zones', z.index, 'id'] })), 'zone'),
    ...checkDuplicateIds(positioned.environments.map((e) => ({ id: e.environment.id, file: e.file, line: e.idLine, segments: ['environments', e.index, 'id'] })), 'environment'),
    ...checkDuplicateIds(positioned.states.map((s) => ({ id: s.state.id, file: s.file, line: s.idLine, segments: ['states', s.index, 'id'] })), 'state'),
  );

  errors.push(...checkContracts(positioned.interfaces));
  errors.push(...checkZoneChangeShape(positioned.elements));
  errors.push(...checkEmptyEnvironmentsList(positioned.elements));

  const stateChainErrors = checkStateChain(positioned.states);
  errors.push(...stateChainErrors);

  // Safe to compute only once the chain itself is known to be one chain:
  // `computeStateOrder` assumes exactly that.
  let stateOrder: string[] | undefined;
  if (stateChainErrors.length === 0) {
    stateOrder = computeStateOrder(positioned.states.map((s) => ({ id: s.state.id, after: s.state.after })));
    errors.push(
      ...checkSinceUntilOrder(
        positioned.elements.map((e) => ({
          since: e.element.since,
          until: e.element.until,
          file: e.file,
          sinceLine: e.sinceLine,
          untilLine: e.untilLine,
          id: e.element.id,
          segments: ['elements', e.index],
        })),
        stateOrder,
      ),
      ...checkSinceUntilOrder(
        positioned.relations.map((r) => ({
          since: r.relation.since,
          until: r.relation.until,
          file: r.file,
          sinceLine: r.sinceLine,
          untilLine: r.untilLine,
          id: r.relation.id,
          segments: ['relations', r.index],
        })),
        stateOrder,
      ),
    );
  }

  // Building the sets of known ids does not need ids to be well-formed or
  // unique, so reference checking runs over every file that passed its
  // schema regardless of what the checks above found; a file that failed
  // its own schema still contributes the ids it declared (`extraKnownIds`),
  // so a correct reference into it from elsewhere is not reported as
  // missing just because that file also had an unrelated mistake.
  const referenceErrors = checkReferences(positioned, extraKnownIds);
  errors.push(...referenceErrors);

  if (referenceErrors.length === 0) {
    const cycleErrors = [...checkParentCycles(positioned.elements), ...checkRefinementCycles(positioned.relations)];
    errors.push(...cycleErrors);

    // Presence (which environments and states a thing exists in) and every
    // check built on it need a cycle-free `parent`/`refines` *and* a known
    // chain of states, so they wait for both.
    if (cycleErrors.length === 0 && stateOrder !== undefined) {
      const ancestors = computeAncestors(positioned.elements.map((e) => ({ id: e.element.id, parent: e.element.parent })));
      errors.push(...checkRefinementEnds(positioned.relations, ancestors));

      const elements = positioned.elements.map((e) => e.element);
      const environmentIds = positioned.environments.map((e) => e.environment.id);

      const elementPresence = computeElementPresence(elements, environmentIds, stateOrder);
      errors.push(...checkEnvironmentsAgainstParent(positioned.elements, elementPresence));
      errors.push(...checkEmptyPresence(positioned.elements, elementPresence, environmentIds.length));

      const relationPresence = computeRelationPresence(
        positioned.relations.map((r) => r.relation),
        elementPresence,
        stateOrder,
      );
      errors.push(...checkEmptyRelationPresence(positioned.relations, relationPresence, environmentIds.length));

      errors.push(...checkZones(positioned, elements, elementPresence));
    }
  }

  return errors;
}

/** Refuses `environments: []`: an element naming environments must name at least one. */
function checkEmptyEnvironmentsList(positioned: PositionedElement[]): ModelError[] {
  const errors: ModelError[] = [];
  for (const entry of positioned) {
    if (entry.element.environments !== undefined && entry.element.environments.length === 0) {
      errors.push(
        errorAt(
          entry.file,
          entry.environmentsLine,
          ['elements', entry.index, 'environments'],
          `element "${entry.element.id}" has an empty "environments"; name at least one, or omit the field to exist in every environment`,
        ),
      );
    }
  }
  return errors;
}

/**
 * Refuses an element naming an environment its parent does not exist in:
 * without this, the environment would be silently dropped by the
 * intersection in `computeElementPresence` instead of refused. Safe to
 * assume every named environment is a real environment id and `parent` is
 * cycle-free: earlier checks already ran and found nothing.
 */
function checkEnvironmentsAgainstParent(positioned: PositionedElement[], elementPresence: ReadonlyMap<string, Presence>): ModelError[] {
  const errors: ModelError[] = [];
  for (const entry of positioned) {
    const parentId = entry.element.parent;
    const own = entry.element.environments;
    if (parentId === undefined || own === undefined) continue;
    const parentPresence = elementPresence.get(parentId);
    if (!parentPresence) continue;

    own.forEach((environmentId, i) => {
      if (parentPresence.environmentIds.includes(environmentId)) return;
      errors.push(
        errorAt(
          entry.file,
          entry.environmentsLines[i] ?? entry.environmentsLine,
          ['elements', entry.index, 'environments', i],
          `element "${entry.element.id}" names environment "${environmentId}", but its parent "${parentId}" does not exist there`,
        ),
      );
    });
  }
  return errors;
}

function presenceReasons(presence: Presence, environmentIdsCount: number): string[] {
  const reasons: string[] = [];
  if (environmentIdsCount > 0 && presence.environmentIds.length === 0) reasons.push('no environment it exists in');
  if (presence.stateIds.length === 0) reasons.push('no state it exists in');
  return reasons;
}

/** Refuses an element that, after inheriting and narrowing presence, exists nowhere. */
function checkEmptyPresence(positioned: PositionedElement[], presenceById: ReadonlyMap<string, Presence>, environmentIdsCount: number): ModelError[] {
  const errors: ModelError[] = [];
  for (const entry of positioned) {
    const presence = presenceById.get(entry.element.id);
    if (!presence) continue;
    const reasons = presenceReasons(presence, environmentIdsCount);
    if (reasons.length === 0) continue;
    errors.push(
      errorAt(
        entry.file,
        entry.idLine,
        ['elements', entry.index, 'id'],
        `element "${entry.element.id}" exists nowhere: it has ${reasons.join(' and ')}`,
      ),
    );
  }
  return errors;
}

/** Refuses a relation that, after inheriting and narrowing presence, exists nowhere. */
function checkEmptyRelationPresence(positioned: PositionedRelation[], presenceById: ReadonlyMap<string, Presence>, environmentIdsCount: number): ModelError[] {
  const errors: ModelError[] = [];
  for (const entry of positioned) {
    const presence = presenceById.get(entry.relation.id);
    if (!presence) continue;
    const reasons = presenceReasons(presence, environmentIdsCount);
    if (reasons.length === 0) continue;
    errors.push(
      errorAt(
        entry.file,
        entry.idLine,
        ['relations', entry.index, 'id'],
        `relation "${entry.relation.id}" exists nowhere: it has ${reasons.join(' and ')}`,
      ),
    );
  }
  return errors;
}

interface IdLike {
  id: string;
  file: string;
  line: number;
  segments: PathSegment[];
}

function checkIdSyntax(items: IdLike[], _kind: string): ModelError[] {
  const errors: ModelError[] = [];
  for (const { id, file, line, segments } of items) {
    if (!ID_PATTERN.test(id)) {
      errors.push(
        errorAt(file, line, segments, `id "${id}" is not valid: ids are letters, digits, dots, dashes and underscores, starting with a letter or digit`),
      );
    }
  }
  return errors;
}

function checkDuplicateIds(items: IdLike[], kind: string): ModelError[] {
  const byId = new Map<string, IdLike[]>();
  for (const entry of items) {
    const group = byId.get(entry.id);
    if (group) group.push(entry);
    else byId.set(entry.id, [entry]);
  }

  const errors: ModelError[] = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const others = group
        .filter((other) => other !== entry)
        .map((other) => `${other.file}:${other.line}`)
        .join(', ');
      errors.push(errorAt(entry.file, entry.line, entry.segments, `${kind} id "${id}" is used more than once; also defined at ${others}`));
    }
  }
  return errors;
}

function checkReferences(positioned: PositionedModel, extraKnownIds: ExtraKnownIds): ModelError[] {
  const errors: ModelError[] = [];
  const elementIds = new Set([...positioned.elements.map((e) => e.element.id), ...extraKnownIds.elements]);
  const interfaceIds = new Set([...positioned.interfaces.map((i) => i.iface.id), ...extraKnownIds.interfaces]);
  const relationIds = new Set([...positioned.relations.map((r) => r.relation.id), ...extraKnownIds.relations]);
  const categoryIds = new Set([...positioned.categories.map((c) => c.category.id), ...extraKnownIds.categories]);
  const zoneIds = new Set([...positioned.zones.map((z) => z.zone.id), ...extraKnownIds.zones]);
  const environmentIds = new Set([...positioned.environments.map((e) => e.environment.id), ...extraKnownIds.environments]);
  const stateIds = new Set([...positioned.states.map((s) => s.state.id), ...extraKnownIds.states]);

  for (const entry of positioned.elements) {
    const base: PathSegment[] = ['elements', entry.index];
    const parent = entry.element.parent;
    if (parent !== undefined && !elementIds.has(parent)) {
      errors.push(errorAt(entry.file, entry.parentLine, [...base, 'parent'], `element "${entry.element.id}" names parent "${parent}", which does not exist`));
    }

    const zonesChange = entry.element.zones;
    if (zonesChange) {
      (zonesChange.add ?? []).forEach((zoneId, i) => {
        if (zoneIds.has(zoneId)) return;
        errors.push(
          errorAt(entry.file, entry.zonesAddLines[i] ?? entry.zonesLine, [...base, 'zones', 'add', i], `element "${entry.element.id}" names zone "${zoneId}", which does not exist`),
        );
      });
      (zonesChange.exclude ?? []).forEach((zoneId, i) => {
        if (zoneIds.has(zoneId)) return;
        errors.push(
          errorAt(entry.file, entry.zonesExcludeLines[i] ?? entry.zonesLine, [...base, 'zones', 'exclude', i], `element "${entry.element.id}" names zone "${zoneId}", which does not exist`),
        );
      });
      (zonesChange.replace ?? []).forEach((zoneId, i) => {
        if (zoneIds.has(zoneId)) return;
        errors.push(
          errorAt(entry.file, entry.zonesReplaceLines[i] ?? entry.zonesLine, [...base, 'zones', 'replace', i], `element "${entry.element.id}" names zone "${zoneId}", which does not exist`),
        );
      });
    }

    (entry.element.environments ?? []).forEach((environmentId, i) => {
      if (environmentIds.has(environmentId)) return;
      errors.push(
        errorAt(
          entry.file,
          entry.environmentsLines[i] ?? entry.environmentsLine,
          [...base, 'environments', i],
          `element "${entry.element.id}" names environment "${environmentId}", which does not exist`,
        ),
      );
    });

    if (entry.element.since !== undefined && !stateIds.has(entry.element.since)) {
      errors.push(errorAt(entry.file, entry.sinceLine, [...base, 'since'], `element "${entry.element.id}" names state "${entry.element.since}", which does not exist`));
    }
    if (entry.element.until !== undefined && !stateIds.has(entry.element.until)) {
      errors.push(errorAt(entry.file, entry.untilLine, [...base, 'until'], `element "${entry.element.id}" names state "${entry.element.until}", which does not exist`));
    }
  }

  for (const entry of positioned.states) {
    const after = entry.state.after;
    if (after !== undefined && !stateIds.has(after)) {
      errors.push(
        errorAt(entry.file, entry.afterLine, ['states', entry.index, 'after'], `state "${entry.state.id}" names "after" as "${after}", which does not exist`),
      );
    }
  }

  for (const entry of positioned.environments) {
    const base: PathSegment[] = ['environments', entry.index];
    for (const zoneLines of entry.zonesLines) {
      if (!elementIds.has(zoneLines.elementId)) {
        errors.push(
          errorAt(
            entry.file,
            zoneLines.line,
            [...base, 'zones', zoneLines.elementId],
            `environment "${entry.environment.id}" names element "${zoneLines.elementId}", which does not exist`,
          ),
        );
        continue;
      }
      const change = entry.environment.zones?.[zoneLines.elementId];
      (change?.add ?? []).forEach((zoneId, i) => {
        if (zoneIds.has(zoneId)) return;
        errors.push(
          errorAt(
            entry.file,
            zoneLines.addLines[i] ?? zoneLines.line,
            [...base, 'zones', zoneLines.elementId, 'add', i],
            `environment "${entry.environment.id}" names zone "${zoneId}", which does not exist`,
          ),
        );
      });
      (change?.exclude ?? []).forEach((zoneId, i) => {
        if (zoneIds.has(zoneId)) return;
        errors.push(
          errorAt(
            entry.file,
            zoneLines.excludeLines[i] ?? zoneLines.line,
            [...base, 'zones', zoneLines.elementId, 'exclude', i],
            `environment "${entry.environment.id}" names zone "${zoneId}", which does not exist`,
          ),
        );
      });
    }
  }

  for (const entry of positioned.interfaces) {
    const provider = entry.iface.provider;
    if (!elementIds.has(provider)) {
      errors.push(
        errorAt(entry.file, entry.providerLine, ['interfaces', entry.index, 'provider'], `interface "${entry.iface.id}" names provider "${provider}", which does not exist`),
      );
    }
  }

  for (const entry of positioned.relations) {
    const { relation } = entry;
    const base: PathSegment[] = ['relations', entry.index];
    if (!elementIds.has(relation.from)) {
      errors.push(errorAt(entry.file, entry.fromLine, [...base, 'from'], `relation "${relation.id}" names "from" as "${relation.from}", which does not exist`));
    }
    if (!elementIds.has(relation.to)) {
      errors.push(errorAt(entry.file, entry.toLine, [...base, 'to'], `relation "${relation.id}" names "to" as "${relation.to}", which does not exist`));
    }
    if (relation.refines !== undefined && !relationIds.has(relation.refines)) {
      errors.push(errorAt(entry.file, entry.refinesLine, [...base, 'refines'], `relation "${relation.id}" refines "${relation.refines}", which does not exist`));
    }
    if (relation.interface !== undefined && !interfaceIds.has(relation.interface)) {
      errors.push(
        errorAt(entry.file, entry.interfaceLine, [...base, 'interface'], `relation "${relation.id}" names interface "${relation.interface}", which does not exist`),
      );
    }
    (relation.transfers ?? []).forEach((transfer, transferIndex) => {
      const lines = entry.transferLines[transferIndex];
      transfer.categories.forEach((categoryId, categoryIndex) => {
        if (categoryIds.has(categoryId)) return;
        errors.push(
          errorAt(
            entry.file,
            lines?.categoryLines[categoryIndex] ?? entry.line,
            [...base, 'transfers', transferIndex, 'categories', categoryIndex],
            `relation "${relation.id}" names category "${categoryId}", which does not exist`,
          ),
        );
      });
    });

    if (relation.since !== undefined && !stateIds.has(relation.since)) {
      errors.push(errorAt(entry.file, entry.sinceLine, [...base, 'since'], `relation "${relation.id}" names state "${relation.since}", which does not exist`));
    }
    if (relation.until !== undefined && !stateIds.has(relation.until)) {
      errors.push(errorAt(entry.file, entry.untilLine, [...base, 'until'], `relation "${relation.id}" names state "${relation.until}", which does not exist`));
    }
  }

  return errors;
}

/**
 * Finds cycles of `parent` references. Safe to assume every `parent` names
 * a known element: reference checking already ran and found nothing.
 */
function checkParentCycles(positioned: PositionedElement[]): ModelError[] {
  const byId = new Map(positioned.map((entry) => [entry.element.id, entry]));
  const errors: ModelError[] = [];
  const reported = new Set<string>();

  for (const start of positioned) {
    if (reported.has(start.element.id)) continue;

    const path: string[] = [];
    const seen = new Set<string>();
    let current: PositionedElement | undefined = start;

    while (current) {
      if (seen.has(current.element.id)) {
        const cycleStart = path.indexOf(current.element.id);
        const cycle = cycleStart >= 0 ? path.slice(cycleStart) : [current.element.id];
        for (const id of cycle) reported.add(id);
        const first = byId.get(cycle[0]!)!;
        errors.push(
          errorAt(first.file, first.parentLine, ['elements', first.index, 'parent'], `elements ${cycle.map((id) => `"${id}"`).join(', ')} form a cycle of parents`),
        );
        break;
      }
      seen.add(current.element.id);
      path.push(current.element.id);
      const parentId: string | undefined = current.element.parent;
      current = parentId === undefined ? undefined : byId.get(parentId);
    }
  }

  return errors;
}

/**
 * Finds cycles of `refines` references, the same way `checkParentCycles`
 * finds cycles of `parent`. Safe to assume every `refines` names a known
 * relation: reference checking already ran and found nothing.
 */
function checkRefinementCycles(positioned: PositionedRelation[]): ModelError[] {
  const byId = new Map(positioned.map((entry) => [entry.relation.id, entry]));
  const errors: ModelError[] = [];
  const reported = new Set<string>();

  for (const start of positioned) {
    if (reported.has(start.relation.id)) continue;

    const path: string[] = [];
    const seen = new Set<string>();
    let current: PositionedRelation | undefined = start;

    while (current) {
      if (seen.has(current.relation.id)) {
        const cycleStart = path.indexOf(current.relation.id);
        const cycle = cycleStart >= 0 ? path.slice(cycleStart) : [current.relation.id];
        for (const id of cycle) reported.add(id);
        const first = byId.get(cycle[0]!)!;
        errors.push(
          errorAt(first.file, first.refinesLine, ['relations', first.index, 'refines'], `relations ${cycle.map((id) => `"${id}"`).join(', ')} form a cycle of refinements`),
        );
        break;
      }
      seen.add(current.relation.id);
      path.push(current.relation.id);
      const refinesId: string | undefined = current.relation.refines;
      current = refinesId === undefined ? undefined : byId.get(refinesId);
    }
  }

  return errors;
}

/**
 * Computes each element's ancestor ids, ordered from the root down to its
 * immediate parent. Safe to assume `parent` is cycle-free: cycle checking
 * already ran and found nothing.
 */
export function computeAncestors(elements: ElementParentLike[]): AncestorsById {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const cache = new Map<string, readonly string[]>();

  const ancestorsOf = (id: string): readonly string[] => {
    const cached = cache.get(id);
    if (cached) return cached;
    const element = byId.get(id);
    const parentId = element?.parent;
    const result = parentId === undefined ? [] : [...ancestorsOf(parentId), parentId];
    cache.set(id, result);
    return result;
  };

  for (const element of elements) ancestorsOf(element.id);
  return cache;
}

/**
 * Checks that a refining relation's ends are the refined relation's ends or
 * their descendants. Safe to assume `refines`, `from` and `to` all name
 * known things: reference checking already ran and found nothing.
 */
function checkRefinementEnds(positioned: PositionedRelation[], ancestors: AncestorsById): ModelError[] {
  const byId = new Map(positioned.map((entry) => [entry.relation.id, entry]));
  const errors: ModelError[] = [];

  const isSameOrDescendant = (candidateId: string, ofId: string): boolean =>
    candidateId === ofId || (ancestors.get(candidateId) ?? []).includes(ofId);

  for (const entry of positioned) {
    const refinesId = entry.relation.refines;
    if (refinesId === undefined) continue;
    const refined = byId.get(refinesId);
    if (!refined) continue;

    if (!isSameOrDescendant(entry.relation.from, refined.relation.from)) {
      errors.push(
        errorAt(
          entry.file,
          entry.fromLine,
          ['relations', entry.index, 'from'],
          `relation "${entry.relation.id}" refines "${refinesId}" but its "from" end "${entry.relation.from}" is not "${refined.relation.from}" or a descendant of it`,
        ),
      );
    }
    if (!isSameOrDescendant(entry.relation.to, refined.relation.to)) {
      errors.push(
        errorAt(
          entry.file,
          entry.toLine,
          ['relations', entry.index, 'to'],
          `relation "${entry.relation.id}" refines "${refinesId}" but its "to" end "${entry.relation.to}" is not "${refined.relation.to}" or a descendant of it`,
        ),
      );
    }
  }

  return errors;
}

const CONTRACT_KINDS = new Set(['http', 'grpc', 'topic', 'queue', 'data', 'rpc']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

/** Parses and normalizes a contract id, or returns `undefined` if it does not parse. */
export function normalizeContract(contract: string): string | undefined {
  const parts = contract.split('::');
  const kind = parts[0];
  if (kind === undefined || !CONTRACT_KINDS.has(kind)) return undefined;

  if (kind === 'http') {
    if (parts.length !== 3) return undefined;
    const [, method, path] = parts;
    if (!method || !path) return undefined;
    if (!HTTP_METHODS.has(method.toUpperCase())) return undefined;
    if (!path.startsWith('/')) return undefined;
    return `http::${method.toUpperCase()}::${path.replace(/\{[^{}]*\}/g, '{}')}`;
  }

  const rest = parts.slice(1).join('::');
  if (rest.length === 0) return undefined;
  return `${kind}::${rest}`;
}

function checkContracts(positioned: PositionedInterface[]): ModelError[] {
  const errors: ModelError[] = [];
  for (const entry of positioned) {
    if (normalizeContract(entry.iface.contract) === undefined) {
      errors.push(
        errorAt(
          entry.file,
          entry.contractLine,
          ['interfaces', entry.index, 'contract'],
          `interface "${entry.iface.id}" has a contract id "${entry.iface.contract}" that does not parse: it must be "kind::rest", the kind being http, grpc, topic, queue, data or rpc, and an http contract must be "http::METHOD::path"`,
        ),
      );
    }
  }
  return errors;
}

/**
 * Checks that `states` forms one chain: at most one state after any given
 * state, and exactly one state with no `after` (the first). Safe to assume
 * every `after` names a known state: reference checking already ran.
 */
function checkStateChain(positioned: PositionedState[]): ModelError[] {
  if (positioned.length === 0) return [];
  const errors: ModelError[] = [];
  const byAfter = new Map<string, PositionedState[]>();
  const roots: PositionedState[] = [];

  for (const entry of positioned) {
    const after = entry.state.after;
    if (after === undefined) {
      roots.push(entry);
      continue;
    }
    const group = byAfter.get(after);
    if (group) group.push(entry);
    else byAfter.set(after, [entry]);
  }

  for (const [after, group] of byAfter) {
    if (group.length < 2) continue;
    const names = group.map((g) => `"${g.state.id}"`).join(', ');
    for (const g of group) {
      errors.push(errorAt(g.file, g.afterLine, ['states', g.index, 'after'], `states ${names} are both after "${after}"; a chain of states cannot branch`));
    }
  }
  if (errors.length > 0) return errors;

  if (roots.length !== 1) {
    if (roots.length === 0) {
      const names = positioned.map((s) => `"${s.state.id}"`).join(', ');
      const first = positioned[0]!;
      errors.push(
        errorAt(first.file, first.line, ['states', first.index, 'after'], `states ${names} have no first state: every state names an "after"`),
      );
    } else {
      const names = roots.map((r) => `"${r.state.id}"`).join(', ');
      for (const r of roots) {
        errors.push(
          errorAt(r.file, r.line, ['states', r.index, 'after'], `states ${names} are all first states; a chain of states must start from exactly one`),
        );
      }
    }
    return errors;
  }

  const visited = new Set<string>();
  let current: PositionedState | undefined = roots[0];
  while (current) {
    visited.add(current.state.id);
    current = byAfter.get(current.state.id)?.[0];
  }

  const leftover = positioned.filter((entry) => !visited.has(entry.state.id));
  if (leftover.length > 0) {
    const names = leftover.map((s) => `"${s.state.id}"`).join(', ');
    for (const entry of leftover) {
      errors.push(errorAt(entry.file, entry.afterLine, ['states', entry.index, 'after'], `states ${names} form a cycle of "after"`));
    }
  }

  return errors;
}

/**
 * The chain of state ids from the first to the last. Safe to assume the
 * chain is valid: `checkStateChain` already ran and found nothing. A model
 * with no `states` has the single implicit state `as-is`.
 */
export function computeStateOrder(states: StateAfterLike[]): string[] {
  if (states.length === 0) return [DEFAULT_STATE_ID];

  const byAfter = new Map<string, StateAfterLike>();
  let root: StateAfterLike | undefined;
  for (const state of states) {
    if (state.after === undefined) root = state;
    else byAfter.set(state.after, state);
  }

  const order: string[] = [];
  let current = root;
  while (current) {
    order.push(current.id);
    current = byAfter.get(current.id);
  }
  return order;
}

interface SinceUntilLike {
  id: string;
  since?: string;
  until?: string;
  file: string;
  sinceLine: number;
  untilLine: number;
  segments: PathSegment[];
}

/**
 * Checks that when both `since` and `until` are given, `since` comes before
 * `until` in the chain of states. Safe to assume both name known states:
 * reference checking already ran.
 */
function checkSinceUntilOrder(entries: SinceUntilLike[], stateOrder: string[]): ModelError[] {
  const indexById = new Map(stateOrder.map((id, index) => [id, index]));
  const errors: ModelError[] = [];
  for (const entry of entries) {
    if (entry.since === undefined || entry.until === undefined) continue;
    const sinceIndex = indexById.get(entry.since);
    const untilIndex = indexById.get(entry.until);
    if (sinceIndex === undefined || untilIndex === undefined) continue;
    if (sinceIndex >= untilIndex) {
      errors.push(
        errorAt(
          entry.file,
          entry.sinceLine,
          [...entry.segments, 'since'],
          `"${entry.id}" has since "${entry.since}", which does not come before until "${entry.until}" in the chain of states`,
        ),
      );
    }
  }
  return errors;
}

/** Refuses an element's `zones` combining `replace` with `add` or `exclude`. */
function checkZoneChangeShape(positioned: PositionedElement[]): ModelError[] {
  const errors: ModelError[] = [];
  for (const entry of positioned) {
    const change = entry.element.zones;
    if (!change || change.replace === undefined) continue;
    if (change.add !== undefined || change.exclude !== undefined) {
      errors.push(
        errorAt(
          entry.file,
          entry.zonesLine,
          ['elements', entry.index, 'zones'],
          `element "${entry.element.id}" combines "replace" with "add" or "exclude" in "zones"; "replace" cannot be combined with either`,
        ),
      );
    }
  }
  return errors;
}

/**
 * Checks an element's zones (general and per environment) the same way in
 * both places: excluding a zone the element is not in — whether in general
 * or, after inheritance, in one environment — is refused naming both, and
 * an environment changing the zones of an element absent from it is
 * refused too. An element's own `exclude` can be valid in general but
 * still invalid inside one particular environment, when that environment
 * already removed the zone from an ancestor; that is refused the same way,
 * pointing back at the element's own `zones.exclude` but naming the
 * environment it fails in. Safe to assume `parent` is cycle-free and every
 * zone, element and environment id known: earlier checks already ran and
 * found nothing.
 */
function checkZones(positioned: PositionedModel, elements: Element[], elementPresence: ReadonlyMap<string, Presence>): ModelError[] {
  const errors: ModelError[] = [];
  const elementById = new Map(positioned.elements.map((entry) => [entry.element.id, entry]));

  const general = resolveGeneralZones(elements);
  for (const [elementId, indexes] of general.invalidExcludes) {
    const entry = elementById.get(elementId)!;
    for (const index of indexes) {
      const zoneId = entry.element.zones?.exclude?.[index]!;
      errors.push(
        errorAt(
          entry.file,
          entry.zonesExcludeLines[index] ?? entry.zonesLine,
          ['elements', entry.index, 'zones', 'exclude', index],
          `element "${elementId}" excludes zone "${zoneId}", which it would not be in`,
        ),
      );
    }
  }

  for (const environmentEntry of positioned.environments) {
    const base: PathSegment[] = ['environments', environmentEntry.index];
    const presentElementIds = new Set(
      elements.filter((element) => elementPresence.get(element.id)?.environmentIds.includes(environmentEntry.environment.id)).map((e) => e.id),
    );
    const inEnvironment = resolveZonesInEnvironment(elements, environmentEntry.environment, presentElementIds);

    for (const [elementId, indexes] of inEnvironment.ownInvalidExcludes) {
      // Already reported once, generally, if the exclude is invalid there
      // too — this environment-specific report is only for an exclude that
      // is valid in general but not in this particular environment.
      const alreadyGeneral = new Set(general.invalidExcludes.get(elementId) ?? []);
      const entry = elementById.get(elementId)!;
      for (const index of indexes) {
        if (alreadyGeneral.has(index)) continue;
        const zoneId = entry.element.zones?.exclude?.[index]!;
        errors.push(
          errorAt(
            entry.file,
            entry.zonesExcludeLines[index] ?? entry.zonesLine,
            ['elements', entry.index, 'zones', 'exclude', index],
            `element "${elementId}" excludes zone "${zoneId}", which it would not be in there in environment "${environmentEntry.environment.id}"`,
          ),
        );
      }
    }

    for (const zoneLines of environmentEntry.zonesLines) {
      if (inEnvironment.absentElementIds.has(zoneLines.elementId)) {
        errors.push(
          errorAt(
            environmentEntry.file,
            zoneLines.line,
            [...base, 'zones', zoneLines.elementId],
            `environment "${environmentEntry.environment.id}" changes the zones of element "${zoneLines.elementId}", which does not exist in it`,
          ),
        );
      }

      const invalidExcludeIndexes = inEnvironment.invalidExcludes.get(zoneLines.elementId) ?? [];
      for (const index of invalidExcludeIndexes) {
        const zoneId = environmentEntry.environment.zones?.[zoneLines.elementId]?.exclude?.[index]!;
        errors.push(
          errorAt(
            environmentEntry.file,
            zoneLines.excludeLines[index] ?? zoneLines.line,
            [...base, 'zones', zoneLines.elementId, 'exclude', index],
            `environment "${environmentEntry.environment.id}" excludes zone "${zoneId}" from element "${zoneLines.elementId}", which it would not be in there`,
          ),
        );
      }
    }
  }

  return errors;
}
