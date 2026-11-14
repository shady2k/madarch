/**
 * The plan one fill press asks a person to confirm (madarch-64o5.63, decision 0035 items 1, 11 and 22): which plugin fills
 * which field of which kind, which fields are the agent's, and which kinds nothing in the manifest can produce at all. The
 * CLI and the fill route answer the same view, so the wiki's fill page and `madarch fill` can never say different things
 * about the same press.
 */
import type { KindsManifest } from '../product/manifest/kinds.js';
import { planManifestFill, type AgentNeed, type FillPlanError, type FillPlanSkip } from '../plugin/fill-declarations.js';

/** One field of a selected kind and the plugins that fill it, in the order the kind's turns run. */
export interface FillPlanField {
  readonly field: string;
  readonly producers: readonly string[];
}

/** One selected kind's place in the plan. */
export interface FillPlanKind {
  readonly kind: string;
  readonly fields: readonly FillPlanField[];
  /** The fields an agent fills, alone or beside a producer it refines. */
  readonly agentFields: readonly string[];
}

/** One unit the plan will run: an output of a plugin for a kind. */
export interface FillPlanUnit {
  readonly plugin: string;
  readonly kind: string;
}

/** The whole plan of one press, as the command and the route answer it. */
export interface FillPlanView {
  /** The selected kinds in the order their turns run, every dependency before its dependant. */
  readonly selectedKinds: readonly string[];
  /** The plugins that run, in plan order. */
  readonly order: readonly string[];
  readonly units: readonly FillPlanUnit[];
  readonly kinds: readonly FillPlanKind[];
  /** The kinds and fields the agent fills: such a plan runs only once an agent is chosen for it. */
  readonly needsAgent: readonly AgentNeed[];
  /** The kinds whose declaration names a plugin the manifest does not hold: a manifest error. */
  readonly errors: readonly FillPlanError[];
  /** The kinds and fields no enabled producer fills in a product without an agent: skipped, with the reason. */
  readonly skipped: readonly FillPlanSkip[];
}

/** The plan a press of the selected kinds plans; the agent is always offered, and `needsAgent` says where it is required. */
export function fillPlanView(manifest: KindsManifest, folder: string, selectedKinds?: readonly string[], requestedKinds?: readonly string[]): FillPlanView {
  const plan = planManifestFill(manifest, folder, selectedKinds, true, requestedKinds);
  const agent = (plugin: string): boolean => manifest.plugins?.get(plugin)?.declaration?.agent !== undefined;
  const kinds = plan.selectedKinds.map((kind) => {
    const fields = [...plan.fieldProducers(kind)].map(([field, producers]) => ({ field, producers }));
    return { kind, fields, agentFields: fields.filter((entry) => entry.producers.some(agent)).map((entry) => entry.field) };
  });
  const units = plan.order.flatMap((plugin) => plan.selectedKinds
    .filter((kind) => plan.outputs.get(plugin)?.has(kind) === true)
    .map((kind) => ({ plugin, kind })));
  return {
    selectedKinds: plan.selectedKinds,
    order: plan.order,
    units,
    kinds,
    needsAgent: plan.agentNeeds,
    errors: plan.errors,
    skipped: plan.skipped,
  };
}
