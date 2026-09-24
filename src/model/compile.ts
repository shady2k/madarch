import type { Category, Element, Environment, Interface, IntendedModel, Relation, ValidatedModel, Zone, ZonesChange } from './schema.js';
import { DEFAULT_STATE_ID } from './schema.js';
import { computeAncestors, computeStateOrder, normalizeContract } from './validate.js';
import type {
  CompiledCategory,
  CompiledElement,
  CompiledEnvironment,
  CompiledInterface,
  CompiledModel,
  CompiledRelation,
  CompiledState,
  CompiledZone,
} from './compiled-schema.js';

export const SCHEMA_VERSION = 1;

export type {
  CompiledCategory,
  CompiledElement,
  CompiledEnvironment,
  CompiledInterface,
  CompiledModel,
  CompiledRelation,
  CompiledState,
  CompiledZone,
};

export function compileModel(model: ValidatedModel): CompiledModel {
  // Sorted by id so the compiled output never depends on which file (or
  // which order of files) a thing was written in: the same model split
  // across files compiles to identical bytes.
  const sortedElements = [...model.elements].sort((a, b) => a.id.localeCompare(b.id));
  const ancestors = computeAncestors(sortedElements);

  const stateOrder = computeStateOrder(model.states);
  const environmentIds = [...model.environments.map((e) => e.id)].sort((a, b) => a.localeCompare(b));

  const generalZones = buildGeneralZones(model);
  const zonesByEnvironment = new Map(
    model.environments.map((environment) => [environment.id, buildZonesInEnvironment(model, environment)]),
  );

  const elementEnvironments = new Map(
    model.elements.map((element) => [
      element.id,
      element.environments !== undefined ? [...element.environments].sort((a, b) => a.localeCompare(b)) : environmentIds,
    ]),
  );
  const elementStates = new Map(
    model.elements.map((element) => [element.id, computeStatesRange(element.since, element.until, stateOrder)]),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    elements: sortedElements.map((element) =>
      compileElement(
        element,
        ancestors.get(element.id) ?? [],
        generalZones.get(element.id) ?? [],
        zonesByEnvironment,
        elementEnvironments.get(element.id) ?? environmentIds,
        elementStates.get(element.id) ?? stateOrder,
      ),
    ),
    interfaces: [...model.interfaces].sort((a, b) => a.id.localeCompare(b.id)).map(compileInterface),
    relations: [...model.relations]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((relation) => compileRelation(relation, elementEnvironments, elementStates, stateOrder)),
    categories: [...model.categories].sort((a, b) => a.id.localeCompare(b.id)).map(compileCategory),
    zones: [...model.zones].sort((a, b) => a.id.localeCompare(b.id)).map(compileZone),
    environments: [...model.environments].sort((a, b) => a.id.localeCompare(b.id)).map(compileEnvironment),
    states: compileStates(model, stateOrder),
  };
}

function compileElement(
  element: Element,
  elementAncestors: readonly string[],
  zones: readonly string[],
  zonesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  environments: readonly string[],
  states: readonly string[],
): CompiledElement {
  const compiled: CompiledElement = {
    id: element.id,
    kind: element.kind,
    ancestors: [...elementAncestors],
    zones: [...zones].sort((a, b) => a.localeCompare(b)),
    zonesByEnvironment: {},
    environments: [...environments],
    states: [...states],
  };
  if (element.name !== undefined) compiled.name = element.name;
  if (element.parent !== undefined) compiled.parent = element.parent;
  if (element.technology !== undefined) compiled.technology = element.technology;
  if (element.evidence !== undefined) compiled.evidence = element.evidence;

  const environmentIds = [...zonesByEnvironment.keys()].sort((a, b) => a.localeCompare(b));
  for (const environmentId of environmentIds) {
    const forEnvironment = zonesByEnvironment.get(environmentId)!.get(element.id) ?? [];
    compiled.zonesByEnvironment[environmentId] = [...forEnvironment].sort((a, b) => a.localeCompare(b));
  }

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

function compileRelation(
  relation: Relation,
  elementEnvironments: ReadonlyMap<string, readonly string[]>,
  elementStates: ReadonlyMap<string, readonly string[]>,
  stateOrder: readonly string[],
): CompiledRelation {
  const ownStates = computeStatesRange(relation.since, relation.until, stateOrder);
  const fromStates = elementStates.get(relation.from) ?? stateOrder;
  const toStates = elementStates.get(relation.to) ?? stateOrder;
  const states = ownStates.filter((id) => fromStates.includes(id) && toStates.includes(id));

  const fromEnvironments = elementEnvironments.get(relation.from) ?? [];
  const toEnvironments = elementEnvironments.get(relation.to) ?? [];
  const environments = fromEnvironments.filter((id) => toEnvironments.includes(id));

  const compiled: CompiledRelation = {
    id: relation.id,
    from: relation.from,
    to: relation.to,
    interaction: relation.interface !== undefined || (relation.transfers?.length ?? 0) > 0,
    environments,
    states,
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

function compileZone(zone: Zone): CompiledZone {
  const compiled: CompiledZone = { id: zone.id, kind: zone.kind };
  if (zone.name !== undefined) compiled.name = zone.name;
  return compiled;
}

function compileEnvironment(environment: Environment): CompiledEnvironment {
  const compiled: CompiledEnvironment = { id: environment.id };
  if (environment.name !== undefined) compiled.name = environment.name;
  if (environment.bindings !== undefined) compiled.bindings = environment.bindings;
  return compiled;
}

/**
 * The model's states, in the order of the chain (so the chain can be read
 * back from the compiled model), sorted by id like every other compiled
 * list. A model with no `states` compiles the single implicit state
 * `as-is`.
 */
function compileStates(model: IntendedModel, stateOrder: readonly string[]): CompiledState[] {
  if (model.states.length === 0) {
    return [{ id: DEFAULT_STATE_ID }];
  }
  const byId = new Map(model.states.map((state) => [state.id, state]));
  return [...stateOrder]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const state = byId.get(id)!;
      const compiled: CompiledState = { id: state.id };
      if (state.name !== undefined) compiled.name = state.name;
      if (state.after !== undefined) compiled.after = state.after;
      return compiled;
    });
}

/** Each element's zones since a state's since is inclusive and until is exclusive. */
function computeStatesRange(since: string | undefined, until: string | undefined, stateOrder: readonly string[]): string[] {
  const sinceIndex = since !== undefined ? stateOrder.indexOf(since) : 0;
  const untilIndex = until !== undefined ? stateOrder.indexOf(until) : stateOrder.length;
  if (sinceIndex < 0 || untilIndex < 0) return [...stateOrder];
  return stateOrder.slice(sinceIndex, untilIndex);
}

/** Applies one `zones` change (add, exclude or replace) to a base set of zone ids. */
function applyZonesChange(base: readonly string[], change: ZonesChange | undefined): string[] {
  if (change?.replace !== undefined) return [...change.replace];
  let zones = [...base];
  for (const zoneId of change?.add ?? []) {
    if (!zones.includes(zoneId)) zones.push(zoneId);
  }
  for (const zoneId of change?.exclude ?? []) {
    zones = zones.filter((existing) => existing !== zoneId);
  }
  return zones;
}

/** Each element's zones in general: inherited from its parent, then its own add, exclude or replace. */
function buildGeneralZones(model: IntendedModel): Map<string, string[]> {
  const byId = new Map(model.elements.map((element) => [element.id, element]));
  const cache = new Map<string, string[]>();

  const resolve = (id: string): string[] => {
    const cached = cache.get(id);
    if (cached) return cached;
    const element = byId.get(id)!;
    const parentZones = element.parent !== undefined ? resolve(element.parent) : [];
    const zones = applyZonesChange(parentZones, element.zones);
    cache.set(id, zones);
    return zones;
  };

  for (const element of model.elements) resolve(element.id);
  return cache;
}

/**
 * Each element's zones in one environment: the same inheritance as the
 * general zones, but starting from the ancestor's zones *in this
 * environment*, so that an environment's change to an element is inherited
 * by its descendants too, then applying the environment's own change to
 * this element, if any.
 */
function buildZonesInEnvironment(model: IntendedModel, environment: Environment): Map<string, string[]> {
  const byId = new Map(model.elements.map((element) => [element.id, element]));
  const cache = new Map<string, string[]>();

  const resolve = (id: string): string[] => {
    const cached = cache.get(id);
    if (cached) return cached;
    const element = byId.get(id)!;
    const parentZones = element.parent !== undefined ? resolve(element.parent) : [];
    let zones = applyZonesChange(parentZones, element.zones);
    const envChange = environment.zones?.[id];
    if (envChange !== undefined) {
      zones = applyZonesChange(zones, { add: envChange.add, exclude: envChange.exclude });
    }
    cache.set(id, zones);
    return zones;
  };

  for (const element of model.elements) resolve(element.id);
  return cache;
}
