import type { ModelError } from './errors.js';
import type { Category, Element, Interface, Relation } from './schema.js';

/**
 * An element together with where it was written, kept only for the
 * duration of loading: ids, references and cycles all need to name a
 * file and a line, but the compiled `IntendedModel` does not carry
 * positions.
 */
export interface PositionedElement {
  element: Element;
  file: string;
  line: number;
  parentLine: number;
}

export interface PositionedInterface {
  iface: Interface;
  file: string;
  line: number;
  providerLine: number;
}

/** The line of each transfer's `categories` entries, parallel to `relation.transfers`. */
export interface TransferLines {
  categoryLines: number[];
}

export interface PositionedRelation {
  relation: Relation;
  file: string;
  line: number;
  fromLine: number;
  toLine: number;
  refinesLine: number;
  interfaceLine: number;
  transferLines: TransferLines[];
}

export interface PositionedCategory {
  category: Category;
  file: string;
  line: number;
}

export interface PositionedModel {
  elements: PositionedElement[];
  interfaces: PositionedInterface[];
  relations: PositionedRelation[];
  categories: PositionedCategory[];
}

/** An element's ancestor ids, ordered from the root down to its immediate parent. */
export type AncestorsById = ReadonlyMap<string, readonly string[]>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates ids and references across the whole model, once every file has
 * parsed and matched the schema. Checks run in stages, each assuming the
 * previous one found nothing: a malformed or duplicate id makes reference
 * and cycle checks meaningless, so later stages are skipped once an earlier
 * one reports a problem.
 */
export function validateModel(positioned: PositionedModel): ModelError[] {
  const syntaxErrors = [
    ...checkIdSyntax(positioned.elements.map((e) => ({ id: e.element.id, file: e.file, line: e.line })), 'element'),
    ...checkIdSyntax(positioned.interfaces.map((i) => ({ id: i.iface.id, file: i.file, line: i.line })), 'interface'),
    ...checkIdSyntax(positioned.relations.map((r) => ({ id: r.relation.id, file: r.file, line: r.line })), 'relation'),
    ...checkIdSyntax(positioned.categories.map((c) => ({ id: c.category.id, file: c.file, line: c.line })), 'category'),
  ];
  if (syntaxErrors.length > 0) return syntaxErrors;

  const duplicateErrors = [
    ...checkDuplicateIds(positioned.elements.map((e) => ({ id: e.element.id, file: e.file, line: e.line })), 'element'),
    ...checkDuplicateIds(positioned.interfaces.map((i) => ({ id: i.iface.id, file: i.file, line: i.line })), 'interface'),
    ...checkDuplicateIds(positioned.relations.map((r) => ({ id: r.relation.id, file: r.file, line: r.line })), 'relation'),
    ...checkDuplicateIds(positioned.categories.map((c) => ({ id: c.category.id, file: c.file, line: c.line })), 'category'),
  ];
  if (duplicateErrors.length > 0) return duplicateErrors;

  const referenceErrors = checkReferences(positioned);
  if (referenceErrors.length > 0) return referenceErrors;

  const cycleErrors = [...checkParentCycles(positioned.elements), ...checkRefinementCycles(positioned.relations)];
  if (cycleErrors.length > 0) return cycleErrors;

  const ancestors = computeAncestors(positioned.elements);

  const refinementEndErrors = checkRefinementEnds(positioned.relations, ancestors);
  if (refinementEndErrors.length > 0) return refinementEndErrors;

  return checkContracts(positioned.interfaces);
}

interface IdLike {
  id: string;
  file: string;
  line: number;
}

function checkIdSyntax(items: IdLike[], kind: string): ModelError[] {
  const errors: ModelError[] = [];
  for (const { id, file, line } of items) {
    if (!ID_PATTERN.test(id)) {
      errors.push({
        file,
        line,
        path: 'id',
        message: `id "${id}" is not valid: ids are letters, digits, dots, dashes and underscores, starting with a letter or digit`,
      });
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
      errors.push({
        file: entry.file,
        line: entry.line,
        path: 'id',
        message: `${kind} id "${id}" is used more than once; also defined at ${others}`,
      });
    }
  }
  return errors;
}

function checkReferences(positioned: PositionedModel): ModelError[] {
  const errors: ModelError[] = [];
  const elementIds = new Set(positioned.elements.map((e) => e.element.id));
  const interfaceIds = new Set(positioned.interfaces.map((i) => i.iface.id));
  const relationIds = new Set(positioned.relations.map((r) => r.relation.id));
  const categoryIds = new Set(positioned.categories.map((c) => c.category.id));

  for (const entry of positioned.elements) {
    const parent = entry.element.parent;
    if (parent !== undefined && !elementIds.has(parent)) {
      errors.push({
        file: entry.file,
        line: entry.parentLine,
        path: 'parent',
        message: `element "${entry.element.id}" names parent "${parent}", which does not exist`,
      });
    }
  }

  for (const entry of positioned.interfaces) {
    const provider = entry.iface.provider;
    if (!elementIds.has(provider)) {
      errors.push({
        file: entry.file,
        line: entry.providerLine,
        path: 'provider',
        message: `interface "${entry.iface.id}" names provider "${provider}", which does not exist`,
      });
    }
  }

  for (const entry of positioned.relations) {
    const { relation } = entry;
    if (!elementIds.has(relation.from)) {
      errors.push({
        file: entry.file,
        line: entry.fromLine,
        path: 'from',
        message: `relation "${relation.id}" names "from" as "${relation.from}", which does not exist`,
      });
    }
    if (!elementIds.has(relation.to)) {
      errors.push({
        file: entry.file,
        line: entry.toLine,
        path: 'to',
        message: `relation "${relation.id}" names "to" as "${relation.to}", which does not exist`,
      });
    }
    if (relation.refines !== undefined && !relationIds.has(relation.refines)) {
      errors.push({
        file: entry.file,
        line: entry.refinesLine,
        path: 'refines',
        message: `relation "${relation.id}" refines "${relation.refines}", which does not exist`,
      });
    }
    if (relation.interface !== undefined && !interfaceIds.has(relation.interface)) {
      errors.push({
        file: entry.file,
        line: entry.interfaceLine,
        path: 'interface',
        message: `relation "${relation.id}" names interface "${relation.interface}", which does not exist`,
      });
    }
    (relation.transfers ?? []).forEach((transfer, transferIndex) => {
      const lines = entry.transferLines[transferIndex];
      transfer.categories.forEach((categoryId, categoryIndex) => {
        if (categoryIds.has(categoryId)) return;
        errors.push({
          file: entry.file,
          line: lines?.categoryLines[categoryIndex] ?? entry.line,
          path: `transfers[${transferIndex}].categories[${categoryIndex}]`,
          message: `relation "${relation.id}" names category "${categoryId}", which does not exist`,
        });
      });
    });
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
        errors.push({
          file: first.file,
          line: first.line,
          path: 'parent',
          message: `elements ${cycle.map((id) => `"${id}"`).join(', ')} form a cycle of parents`,
        });
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
        errors.push({
          file: first.file,
          line: first.line,
          path: 'refines',
          message: `relations ${cycle.map((id) => `"${id}"`).join(', ')} form a cycle of refinements`,
        });
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
export function computeAncestors(positioned: PositionedElement[]): AncestorsById {
  const byId = new Map(positioned.map((entry) => [entry.element.id, entry]));
  const cache = new Map<string, readonly string[]>();

  const ancestorsOf = (id: string): readonly string[] => {
    const cached = cache.get(id);
    if (cached) return cached;
    const entry = byId.get(id);
    const parentId = entry?.element.parent;
    const result = parentId === undefined ? [] : [...ancestorsOf(parentId), parentId];
    cache.set(id, result);
    return result;
  };

  for (const entry of positioned) ancestorsOf(entry.element.id);
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
      errors.push({
        file: entry.file,
        line: entry.fromLine,
        path: 'from',
        message: `relation "${entry.relation.id}" refines "${refinesId}" but its "from" end "${entry.relation.from}" is not "${refined.relation.from}" or a descendant of it`,
      });
    }
    if (!isSameOrDescendant(entry.relation.to, refined.relation.to)) {
      errors.push({
        file: entry.file,
        line: entry.toLine,
        path: 'to',
        message: `relation "${entry.relation.id}" refines "${refinesId}" but its "to" end "${entry.relation.to}" is not "${refined.relation.to}" or a descendant of it`,
      });
    }
  }

  return errors;
}

const CONTRACT_KINDS = new Set(['http', 'grpc', 'topic', 'queue', 'data', 'rpc']);

/** Parses and normalizes a contract id, or returns `undefined` if it does not parse. */
export function normalizeContract(contract: string): string | undefined {
  const parts = contract.split('::');
  const kind = parts[0];
  if (kind === undefined || !CONTRACT_KINDS.has(kind)) return undefined;

  if (kind === 'http') {
    if (parts.length !== 3) return undefined;
    const [, method, path] = parts;
    if (!method || !path) return undefined;
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
      errors.push({
        file: entry.file,
        line: entry.line,
        path: 'contract',
        message: `interface "${entry.iface.id}" has a contract id "${entry.iface.contract}" that does not parse: it must be "kind::rest", the kind being http, grpc, topic, queue, data or rpc, and an http contract must be "http::METHOD::path"`,
      });
    }
  }
  return errors;
}
