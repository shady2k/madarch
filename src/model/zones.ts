import type { Element, Environment } from './schema.js';

/**
 * The one place that works out an element's zones — inherited from its
 * parent, then its own (or, in one environment, that environment's) add,
 * exclude or replace. Used by `validate.ts` (which turns an invalid exclude
 * or an environment change to an absent element into a `ModelError`) and by
 * `compile.ts` (which assumes the model is already valid and only needs the
 * resulting sets).
 */

export interface ZoneChangeLike {
  add?: readonly string[];
  exclude?: readonly string[];
  replace?: readonly string[];
}

export interface ZonesResolution {
  zones: string[];
  /** Indexes into `exclude` naming a zone the base set did not contain. */
  invalidExcludeIndexes: number[];
}

/** Applies one `zones` change (add, exclude or replace) to a base set of zone ids. */
export function applyZonesChange(base: readonly string[], change: ZoneChangeLike | undefined): ZonesResolution {
  if (change?.replace !== undefined) return { zones: [...change.replace], invalidExcludeIndexes: [] };

  let zones = [...base];
  for (const zoneId of change?.add ?? []) {
    if (!zones.includes(zoneId)) zones.push(zoneId);
  }
  const invalidExcludeIndexes: number[] = [];
  (change?.exclude ?? []).forEach((zoneId, index) => {
    if (!zones.includes(zoneId)) invalidExcludeIndexes.push(index);
    zones = zones.filter((existing) => existing !== zoneId);
  });
  return { zones, invalidExcludeIndexes };
}

export interface GeneralZonesResult {
  /** Each element's zones in general (not in any one environment). */
  zonesById: Map<string, string[]>;
  /** Elements whose own `zones.exclude` named a zone they were not in, by index. */
  invalidExcludes: Map<string, number[]>;
}

/**
 * Each element's zones in general: inherited from its parent, then its own
 * add, exclude or replace. Safe to assume `parent` is cycle-free.
 */
export function resolveGeneralZones(elements: readonly Element[]): GeneralZonesResult {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const zonesById = new Map<string, string[]>();
  const invalidExcludes = new Map<string, number[]>();

  const resolve = (id: string): string[] => {
    const cached = zonesById.get(id);
    if (cached) return cached;
    const element = byId.get(id)!;
    const parentZones = element.parent !== undefined ? resolve(element.parent) : [];
    const { zones, invalidExcludeIndexes } = applyZonesChange(parentZones, element.zones);
    if (invalidExcludeIndexes.length > 0) invalidExcludes.set(id, invalidExcludeIndexes);
    zonesById.set(id, zones);
    return zones;
  };

  for (const element of elements) resolve(element.id);
  return { zonesById, invalidExcludes };
}

export interface EnvironmentZonesResult {
  /** Each element's zones in this one environment. */
  zonesById: Map<string, string[]>;
  /** Elements whose exclude, in this environment, named a zone they were not in there, by index. */
  invalidExcludes: Map<string, number[]>;
  /** Elements this environment changes the zones of although the element does not exist in it. */
  absentElementIds: Set<string>;
}

/**
 * Each element's zones in one environment: the same inheritance as the
 * general zones, but starting from the ancestor's zones *in this
 * environment*, so that an environment's change to an element is inherited
 * by its descendants too, then applying the environment's own change to
 * this element, if any — refusing (via `invalidExcludes`/`absentElementIds`)
 * the same two mistakes an element's own `zones` can make: excluding a zone
 * the element is not in there, and changing the zones of an element that
 * does not exist in this environment at all.
 */
export function resolveZonesInEnvironment(
  elements: readonly Element[],
  environment: Environment,
  presentElementIds: ReadonlySet<string>,
): EnvironmentZonesResult {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const zonesById = new Map<string, string[]>();
  const invalidExcludes = new Map<string, number[]>();
  const absentElementIds = new Set<string>();

  const resolve = (id: string): string[] => {
    const cached = zonesById.get(id);
    if (cached) return cached;
    const element = byId.get(id)!;
    const parentZones = element.parent !== undefined ? resolve(element.parent) : [];
    let zones = applyZonesChange(parentZones, element.zones).zones;

    const envChange = environment.zones?.[id];
    if (envChange !== undefined) {
      if (!presentElementIds.has(id)) {
        absentElementIds.add(id);
      } else {
        const { zones: changed, invalidExcludeIndexes } = applyZonesChange(zones, {
          add: envChange.add,
          exclude: envChange.exclude,
        });
        zones = changed;
        if (invalidExcludeIndexes.length > 0) invalidExcludes.set(id, invalidExcludeIndexes);
      }
    }

    zonesById.set(id, zones);
    return zones;
  };

  for (const element of elements) resolve(element.id);
  return { zonesById, invalidExcludes, absentElementIds };
}
