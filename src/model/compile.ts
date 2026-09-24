import type { Binding, Category, Element, Environment, Evidence, Interface, IntendedModel, Relation, Transfer, ValidatedModel, Zone } from './schema.js';
import { DEFAULT_STATE_ID } from './schema.js';
import { computeAncestors, computeStateOrder, normalizeContract } from './validate.js';
import { computeElementPresence, computeRelationPresence, formatEnvironments, type Presence } from './presence.js';
import { resolveGeneralZones, resolveZonesInEnvironment } from './zones.js';
import { byCodePoint, sortedByCodePoint } from './order.js';
import { COMPILED_SCHEMA_VERSION } from './compiled-schema.js';
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

export const SCHEMA_VERSION = COMPILED_SCHEMA_VERSION;

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
  const sortedElements = [...model.elements].sort((a, b) => byCodePoint(a.id, b.id));
  const ancestors = computeAncestors(sortedElements);

  const stateOrder = computeStateOrder(model.states);
  const environmentIds = sortedByCodePoint(model.environments.map((e) => e.id));

  const elementPresence = computeElementPresence(model.elements, environmentIds, stateOrder);
  const relationPresence = computeRelationPresence(model.relations, elementPresence, stateOrder);

  const general = resolveGeneralZones(model.elements);
  const zonesByEnvironment = new Map(
    model.environments.map((environment) => {
      const presentElementIds = new Set(
        model.elements.filter((element) => elementPresence.get(element.id)?.environmentIds.includes(environment.id)).map((e) => e.id),
      );
      return [environment.id, resolveZonesInEnvironment(model.elements, environment, presentElementIds).zonesById];
    }),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    elements: sortedElements.map((element) =>
      compileElement(element, ancestors.get(element.id) ?? [], general.zonesById.get(element.id) ?? [], zonesByEnvironment, elementPresence, environmentIds),
    ),
    interfaces: [...model.interfaces].sort((a, b) => byCodePoint(a.id, b.id)).map(compileInterface),
    relations: [...model.relations]
      .sort((a, b) => byCodePoint(a.id, b.id))
      .map((relation) => compileRelation(relation, relationPresence, environmentIds, model.environments)),
    categories: [...model.categories].sort((a, b) => byCodePoint(a.id, b.id)).map(compileCategory),
    zones: [...model.zones].sort((a, b) => byCodePoint(a.id, b.id)).map(compileZone),
    environments: [...model.environments].sort((a, b) => byCodePoint(a.id, b.id)).map(compileEnvironment),
    states: compileStates(model, stateOrder),
  };
}

/**
 * `model.json`'s exact text: the same stable key order `compileModel`
 * already builds its objects in, rendered with two-space indentation and a
 * trailing newline. The same model, compiled twice — from the same files or
 * from the same content split differently across files — produces this same
 * text byte for byte.
 */
export function serializeCompiledModel(model: CompiledModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

function compileElement(
  element: Element,
  elementAncestors: readonly string[],
  zones: readonly string[],
  zonesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  elementPresence: ReadonlyMap<string, Presence>,
  environmentIds: readonly string[],
): CompiledElement {
  const presence = elementPresence.get(element.id) ?? { environmentIds: [], stateIds: [] };

  const compiled: CompiledElement = {
    id: element.id,
    kind: element.kind,
    ancestors: [...elementAncestors],
    zones: sortedByCodePoint(zones),
    zonesByEnvironment: {},
    // With no environments declared, every element is trivially
    // unrestricted; that is written as the sentinel "*" rather than "[]" so
    // "every environment" and "no environment" (refused before compilation)
    // can never be confused.
    environments: formatEnvironments(presence.environmentIds, environmentIds, sortedByCodePoint),
    states: [...presence.stateIds],
  };
  if (element.name !== undefined) compiled.name = element.name;
  if (element.parent !== undefined) compiled.parent = element.parent;
  if (element.technology !== undefined) compiled.technology = element.technology;
  if (element.evidence !== undefined) compiled.evidence = rebuildEvidence(element.evidence);

  // Only the environments the element actually exists in.
  for (const environmentId of presence.environmentIds) {
    const forEnvironment = zonesByEnvironment.get(environmentId)?.get(element.id) ?? [];
    compiled.zonesByEnvironment[environmentId] = sortedByCodePoint(forEnvironment);
  }

  return compiled;
}

function compileInterface(iface: Interface): CompiledInterface {
  const normalized = normalizeContract(iface.contract);
  // `load` already refused a model whose contract does not parse, so this
  // is always defined by the time compilation runs.
  const compiled: CompiledInterface = { id: iface.id, provider: iface.provider, contract: normalized ?? iface.contract };
  if (iface.evidence !== undefined) compiled.evidence = rebuildEvidence(iface.evidence);
  return compiled;
}

function compileRelation(
  relation: Relation,
  relationPresence: ReadonlyMap<string, Presence>,
  environmentIds: readonly string[],
  environments: readonly Environment[],
): CompiledRelation {
  const presence = relationPresence.get(relation.id) ?? { environmentIds: [], stateIds: [] };

  const compiled: CompiledRelation = {
    id: relation.id,
    from: relation.from,
    to: relation.to,
    interaction: relation.interface !== undefined || (relation.transfers?.length ?? 0) > 0,
    environments: formatEnvironments(presence.environmentIds, environmentIds, sortedByCodePoint),
    states: [...presence.stateIds],
  };
  if (relation.refines !== undefined) compiled.refines = relation.refines;
  if (relation.interface !== undefined) compiled.interface = relation.interface;
  if (relation.binding !== undefined) {
    compiled.binding = rebuildBinding(relation.binding);
    compiled.bindingByEnvironment = compileBindingByEnvironment(relation.binding, presence.environmentIds, environments);
  }
  if (relation.transfers !== undefined) compiled.transfers = rebuildTransfers(relation.transfers);
  if (relation.evidence !== undefined) compiled.evidence = rebuildEvidence(relation.evidence);
  return compiled;
}

/**
 * The relation's binding variable's value in each environment it exists
 * in. A binding variable an environment does not define is recorded as
 * absent there (the key is left out), never as an error: secret values are
 * the author's responsibility, not this compiler's. Built on an object with
 * no prototype (see `rebuildBindings`): `binding.env` names an environment
 * id here, which the schema already restricts away from `"__proto__"`, but
 * nothing should have to rely on that to stay safe.
 */
function compileBindingByEnvironment(binding: Binding, presenceEnvironmentIds: readonly string[], environments: readonly Environment[]): Record<string, string> {
  const byId = new Map(environments.map((e) => [e.id, e]));
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const environmentId of sortedByCodePoint(presenceEnvironmentIds)) {
    const value = byId.get(environmentId)?.bindings?.[binding.env];
    if (value !== undefined) result[environmentId] = value;
  }
  return result;
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
  if (environment.bindings !== undefined) compiled.bindings = rebuildBindings(environment.bindings);
  return compiled;
}

/**
 * The model's states, in the order of the chain from first to last, so
 * the chain can be read back from the compiled model without recomputing
 * it. A model with no `states` compiles the single implicit state `as-is`.
 */
function compileStates(model: IntendedModel, stateOrder: readonly string[]): CompiledState[] {
  if (model.states.length === 0) {
    return [{ id: DEFAULT_STATE_ID }];
  }
  const byId = new Map(model.states.map((state) => [state.id, state]));
  return stateOrder.map((id) => {
    const state = byId.get(id)!;
    const compiled: CompiledState = { id: state.id };
    if (state.name !== undefined) compiled.name = state.name;
    if (state.after !== undefined) compiled.after = state.after;
    return compiled;
  });
}

/**
 * Every object passed through from the source YAML into the compiled
 * model is rebuilt with keys in a fixed order, so that writing the same
 * fields in a different order in the source (or, for `bindings`, giving the
 * same variables in a different order) never changes the compiled bytes.
 */
function rebuildEvidence(evidence: readonly Evidence[]): Evidence[] {
  return evidence.map((entry) => {
    const rebuilt: Evidence = { file: entry.file };
    if (entry.line !== undefined) rebuilt.line = entry.line;
    return rebuilt;
  });
}

function rebuildTransfers(transfers: readonly Transfer[]): Transfer[] {
  return transfers.map((transfer) => ({
    direction: transfer.direction,
    confidentiality: transfer.confidentiality,
    categories: [...transfer.categories],
  }));
}

function rebuildBinding(binding: Binding): Binding {
  return { env: binding.env };
}

/**
 * Rebuilds a `bindings` record with keys in a fixed (sorted) order,
 * starting from an object with no prototype (`Object.create(null)`): a
 * binding variable can be named anything, `"__proto__"` and `"constructor"`
 * included, and assigning through `[key] =` on an ordinary `{}` would, for
 * `"__proto__"`, set the object's prototype instead of a real, enumerable,
 * serializable property — silently losing that binding. An object with no
 * prototype has no such special key, so every variable name, however it
 * reads, survives as a normal own property.
 */
function rebuildBindings(bindings: Readonly<Record<string, string>>): Record<string, string> {
  const rebuilt: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of sortedByCodePoint(Object.keys(bindings))) rebuilt[key] = bindings[key]!;
  return rebuilt;
}
