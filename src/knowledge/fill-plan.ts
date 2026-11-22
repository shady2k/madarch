/**
 * The plan one fill press asks a person to confirm (madarch-64o5.63, decision 0035 items 1, 11 and 22): which plugin fills
 * which field of which kind, which fields are the agent's, and which kinds nothing in the manifest can produce at all. The
 * CLI and the fill route answer the same view, so the wiki's fill page and `madarch fill` can never say different things
 * about the same press.
 */
import type { KindApplicability } from '../graph/applicability.js';
import { byCodePoint } from '../model/order.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { planManifestFill, type AgentNeed, type FillPlanError, type FillPlanSkip } from '../plugin/fill-declarations.js';

/** One field of a selected kind and the plugins that fill it, in the order the kind's turns run. */
export interface FillPlanField {
  readonly field: string;
  /** The field's reader-facing name from its declaration, when it declares one. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly producers: readonly string[];
}

/** One selected kind's place in the plan. */
export interface FillPlanKind {
  readonly kind: string;
  readonly fields: readonly FillPlanField[];
  /** The fields an agent fills, alone or beside a producer it refines. */
  readonly agentFields: readonly string[];
  readonly applicability: KindApplicability;
}

/** One unit the plan will run: an output of a plugin for a kind. */
export interface FillPlanUnit {
  readonly plugin: string;
  readonly kind: string;
}

/** The whole plan of one press, as the command and the route answer it. */
export interface FillPlanView {
  /** The plugins the manifest declares, with their names for a reader (an id when a declaration names none). */
  readonly plugins: readonly { readonly name: string; readonly labels: Readonly<Record<string, string>> }[];
  /** The selected kinds in the order their turns run, every dependency before its dependant. */
  readonly selectedKinds: readonly string[];
  /** The kinds the person asked for (the dependencies are the rest of `selectedKinds`). */
  readonly requestedKinds: readonly string[];
  /** The prerequisites the plan added, with the kind whose request brought each one in. */
  readonly added: readonly { readonly kind: string; readonly neededBy: string }[];
  /** The plugins that run, in plan order. */
  readonly order: readonly string[];
  readonly units: readonly FillPlanUnit[];
  readonly kinds: readonly FillPlanKind[];
  /** Catalogue-only prerequisites have no producer and remain empty; they do not block the walk. */
  readonly emptyKinds: readonly { readonly kind: string; readonly state: 'no-producer-declared' }[];
  /** The kinds and fields the agent fills: such a plan runs only once an agent is chosen for it. */
  readonly needsAgent: readonly AgentNeed[];
  /** The kinds whose declaration names a plugin the manifest does not hold: a manifest error. */
  readonly errors: readonly FillPlanError[];
  /** True when the plan runs only deterministic plugins: the agent's fields stay unfilled by this press. */
  readonly pluginsOnly: boolean;
  /** The kinds and fields no enabled producer fills in a product without an agent: skipped, with the reason. */
  readonly skipped: readonly (FillPlanSkip & {readonly applicability?: KindApplicability})[];
}

/** The plan a press of the selected kinds plans; the agent is always offered, and `needsAgent` says where it is required. */
export function fillPlanView(
  manifest: KindsManifest,
  folder: string,
  selectedKinds?: readonly string[],
  requestedKinds?: readonly string[],
  entries: readonly { readonly kind: string; readonly reason: 'requested' | 'dependency'; readonly namedBy: string }[] = [],
  pluginsOnly = false,
  applicability: readonly KindApplicability[] = [],
): FillPlanView {
  // The full plan is what the page shows: every field's producer, the agent's fields, and a missing plugin's error. A
  // plugins-only press runs the deterministic part; the same view says which fields nobody will fill this time.
  const plan = planManifestFill(manifest, folder, selectedKinds, true, requestedKinds);
  const run = pluginsOnly ? planManifestFill(manifest, folder, selectedKinds, false, requestedKinds, true) : plan;
  const agent = (plugin: string): boolean => manifest.plugins?.get(plugin)?.declaration?.agent !== undefined;
  const kinds = plan.selectedKinds.map((kind) => {
    const declared = manifest.kinds.get(kind)?.fields ?? [];
    const fields = [...plan.fieldProducers(kind)].map(([field, producers]) => {
      const labels = declared.find((one) => one.name === field)?.labels;
      return { field, producers, ...(labels === undefined ? {} : { labels: { ...labels } }) };
    });
    return { kind, fields, applicability: applicability.find(mark => mark.kind === kind) ?? {kind,state:'not-searched' as const,reason:'No applicability search recorded',evidence:[],contested:false}, agentFields: fields.filter((entry) => entry.producers.some(agent)).map((entry) => entry.field) };
  });
  const units = run.order.flatMap((plugin) => run.selectedKinds
    .filter((kind) => run.outputs.get(plugin)?.has(kind) === true && !(agent(plugin) && applicability.some(mark => mark.kind === kind && mark.state === 'inapplicable')))
    .map((kind) => ({ plugin, kind })));
  const plugins = [...(manifest.plugins?.values() ?? [])]
    .flatMap((plugin) => plugin.declaration === undefined ? [] : [{ name: plugin.declaration.name, labels: { ...(plugin.declaration.labels ?? {}) } }])
    .sort((left, right) => byCodePoint(left.name, right.name));
  return {
    plugins,
    selectedKinds: plan.selectedKinds,
    requestedKinds: [...new Set(requestedKinds ?? entries.filter((entry) => entry.reason === 'requested').map((entry) => entry.kind))],
    added: entries.filter((entry) => entry.reason === 'dependency').map((entry) => ({ kind: entry.kind, neededBy: entry.namedBy })),
    order: run.order,
    units,
    kinds,
    emptyKinds: plan.emptyKinds,
    needsAgent: plan.agentNeeds.filter(need => !applicability.some(mark => mark.kind === need.kind && mark.state === 'inapplicable')),
    errors: plan.errors,
    pluginsOnly,
    skipped: [...plan.skipped, ...kinds.filter(entry => entry.applicability.state === 'inapplicable').map(entry => ({kind:entry.kind,fields:entry.agentFields,reason:entry.applicability.reason,applicability:entry.applicability}))],
  };
}
