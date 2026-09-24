import type { Binding, Category, Element, Evidence, Interface, IntendedModel, Relation, Transfer } from './schema.js';
import { computeAncestors, normalizeContract, type PositionedElement } from './validate.js';

export const SCHEMA_VERSION = 1;

export interface CompiledElement {
  id: string;
  kind: Element['kind'];
  name?: string;
  parent?: string;
  /** Ancestor ids, ordered from the root down to the immediate parent. */
  ancestors: string[];
  evidence?: Evidence[];
}

export interface CompiledInterface {
  id: string;
  provider: string;
  contract: string;
  evidence?: Evidence[];
}

export interface CompiledRelation {
  id: string;
  from: string;
  to: string;
  refines?: string;
  interface?: string;
  /** True when the relation carries an interface or transfers: it is an interaction. */
  interaction: boolean;
  binding?: Binding;
  transfers?: Transfer[];
  evidence?: Evidence[];
}

export interface CompiledCategory {
  id: string;
  name?: string;
}

/**
 * The normalized JSON every frontend and agent reads. `JSON.stringify`
 * of this object is `model.json`. Later tasks add zones, environments and
 * states alongside `elements`, `interfaces`, `relations` and `categories`.
 */
export interface CompiledModel {
  schemaVersion: typeof SCHEMA_VERSION;
  elements: CompiledElement[];
  interfaces: CompiledInterface[];
  relations: CompiledRelation[];
  categories: CompiledCategory[];
}

export function compileModel(model: IntendedModel): CompiledModel {
  // Sorted by id so the compiled output never depends on which file (or
  // which order of files) a thing was written in: the same model split
  // across files compiles to identical bytes.
  const sortedElements = [...model.elements].sort((a, b) => a.id.localeCompare(b.id));
  const ancestors = computeAncestors(
    sortedElements.map(
      (element): PositionedElement => ({ element, file: '', line: 0, parentLine: 0 }),
    ),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    elements: sortedElements.map((element) => compileElement(element, ancestors.get(element.id) ?? [])),
    interfaces: [...model.interfaces].sort((a, b) => a.id.localeCompare(b.id)).map(compileInterface),
    relations: [...model.relations].sort((a, b) => a.id.localeCompare(b.id)).map(compileRelation),
    categories: [...model.categories].sort((a, b) => a.id.localeCompare(b.id)).map(compileCategory),
  };
}

function compileElement(element: Element, elementAncestors: readonly string[]): CompiledElement {
  const compiled: CompiledElement = { id: element.id, kind: element.kind, ancestors: [...elementAncestors] };
  if (element.name !== undefined) compiled.name = element.name;
  if (element.parent !== undefined) compiled.parent = element.parent;
  if (element.evidence !== undefined) compiled.evidence = element.evidence;
  return compiled;
}

function compileInterface(iface: Interface): CompiledInterface {
  const normalized = normalizeContract(iface.contract);
  // `load` already refused a model whose contract does not parse, so this
  // is always defined by the time compilation runs.
  const compiled: CompiledInterface = { id: iface.id, provider: iface.provider, contract: normalized ?? iface.contract };
  if (iface.evidence !== undefined) compiled.evidence = iface.evidence;
  return compiled;
}

function compileRelation(relation: Relation): CompiledRelation {
  const compiled: CompiledRelation = {
    id: relation.id,
    from: relation.from,
    to: relation.to,
    interaction: relation.interface !== undefined || (relation.transfers?.length ?? 0) > 0,
  };
  if (relation.refines !== undefined) compiled.refines = relation.refines;
  if (relation.interface !== undefined) compiled.interface = relation.interface;
  if (relation.binding !== undefined) compiled.binding = relation.binding;
  if (relation.transfers !== undefined) compiled.transfers = relation.transfers;
  if (relation.evidence !== undefined) compiled.evidence = relation.evidence;
  return compiled;
}

function compileCategory(category: Category): CompiledCategory {
  const compiled: CompiledCategory = { id: category.id };
  if (category.name !== undefined) compiled.name = category.name;
  return compiled;
}
