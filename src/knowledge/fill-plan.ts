
/**
 * The fill plan a command page reads (decision 0036, sections 7 and 8): the kinds a fill may take, the fields each
 * plugin fills, the fields the agent fills, and the dependency order of a selection. The plan itself is the engine's
 * (`planManifestFill`, `readFillTargets`): the app draws what this answer states and computes no plan of its own.
 *
 * The names are the catalogue's: a kind is answered with its labels in the reader's language, together with the area it
 * belongs to, so no page has to spell an internal kind. A kind whose fields no enabled producer fills is listed as such.
 */
import { planManifestFill } from '../plugin/fill-declarations.js';
import { fillTargets, readFillTargets, type FillTargetEntry } from './fill-targets.js';
import type { KindDecl, KindsManifest } from '../product/manifest/kinds.js';

/** The fields one kind's plan fills, and by whom. */
export interface FillPlanField {
  readonly field: string;
  /** The plugins whose declared output names the field. */
  readonly plugins: readonly string[];
  /** Whether one of them is the agent producer: the field goes to the agent. */
  readonly agent: boolean;
}

/** One kind in a plan, with the catalogue's words for it. */
export interface FillPlanKind {
  readonly kind: string;
  readonly labels: { readonly one: string; readonly many: string };
  readonly group: { readonly name: string; readonly label: string } | null;
  /** Why the kind is in the plan: the person asked for it, or a selected kind needs it. */
  readonly reason?: FillTargetEntry['reason'];
  /** The kind whose request brought this one in, for a dependency. */
  readonly namedBy?: string;
  /** Every plugin that fills any field of the kind. */
  readonly plugins: readonly string[];
  readonly fields: readonly FillPlanField[];
  /** True when the agent fills at least one field of the kind. */
  readonly agent: boolean;
}

/** What a fill page reads: the catalogue, and the plan of the kinds it asked for. */
export interface FillPlanView {
  /** The selected kinds and their dependencies, in dependency order. Empty when the address selected none. */
  readonly order: readonly string[];
  /** The selected kinds and their dependencies, with what puts each in the plan. */
  readonly kinds: readonly FillPlanKind[];
  /** Every kind the manifest declares, in dependency order, for the page to choose from. */
  readonly catalogue: readonly FillPlanKind[];
  /** True when the plan holds the agent. */
  readonly requiresAgent: boolean;
  /** The selected kinds no enabled producer fills (they would abstain). */
  readonly unproduced: readonly string[];
  /** Why the plan cannot be made, when it cannot; the page shows it and runs nothing. */
  readonly refusal?: string;
}

type Plan = ReturnType<typeof planManifestFill>;

function wordOf(labels: Readonly<Record<string, { readonly one: string; readonly many: string }>> | undefined, language: string, fallback: string): { one: string; many: string } {
  return labels?.[language] ?? labels?.['en'] ?? { one: fallback, many: fallback };
}

function groupOf(manifest: KindsManifest, decl: KindDecl, language: string): { name: string; label: string } | null {
  if (decl.group === undefined) return null;
  const group = manifest.groups.get(decl.group);
  const label = group?.labels[language] ?? group?.labels['en'] ?? group?.name ?? decl.group;
  return { name: decl.group, label };
}

/** The agent plugin names a plan may hold: a declaration with an `agent` section writes with a model. */
function agentPluginsOf(manifest: KindsManifest): Set<string> {
  const names = new Set<string>();
  for (const plugin of manifest.plugins?.values() ?? []) {
    if (plugin.declaration?.agent !== undefined) names.add(plugin.declaration.name);
  }
  return names;
}

function kindView(manifest: KindsManifest, plan: Plan | undefined, kind: string, language: string, agents: ReadonlySet<string>): FillPlanKind {
  const decl = manifest.kinds.get(kind);
  const plugins = plan === undefined || decl === undefined ? [] : plan.order.filter((name) => plan.outputs.get(name)?.has(kind));
  const fields = (decl?.fields ?? []).map((field) => {
    const producers = plan === undefined ? [] : plan.producers(kind, field.name);
    return { field: field.name, plugins: producers, agent: producers.some((name) => agents.has(name)) };
  });
  return {
    kind,
    labels: wordOf(decl?.labels, language, kind),
    group: decl === undefined ? null : groupOf(manifest, decl, language),
    plugins,
    fields,
    agent: fields.some((field) => field.agent),
  };
}

/**
 * The catalogue's kinds in the manifest's own reading order: its groups in the order the navigation lists them, the kinds
 * of each in the manifest's declaration order, and the kinds of no group last. The plan of a selection keeps the
 * dependency order the fill uses; this order is the page's list.
 */
function catalogueOrder(manifest: KindsManifest): readonly string[] {
  const groups = new Set(manifest.groups.keys());
  const loose: string[] = [];
  const seen = new Set<string>();
  const grouped = new Map<string, string[]>();
  for (const kind of manifest.kinds.values()) {
    if (kind.group !== undefined && groups.has(kind.group)) {
      const list = grouped.get(kind.group) ?? [];
      list.push(kind.name);
      grouped.set(kind.group, list);
    } else {
      loose.push(kind.name);
    }
  }
  const ordered: string[] = [];
  for (const group of manifest.groups.keys()) {
    for (const kind of grouped.get(group) ?? []) { ordered.push(kind); seen.add(kind); }
  }
  for (const kind of loose) if (!seen.has(kind)) ordered.push(kind);
  // A kind the group map lost is still a kind of the manifest: never a smaller catalogue.
  for (const kind of manifest.kinds.keys()) if (!ordered.includes(kind)) ordered.push(kind);
  return ordered;
}

function planOf(manifest: KindsManifest, folder: string, order: readonly string[]): { plan?: Plan; refusal?: string } {
  try {
    return { plan: planManifestFill(manifest, folder, order, true) };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The plan one address asks for. `selected` is the kinds the person checked; with none, the answer is the catalogue
 * alone, since nothing is chosen yet. The agent is planned as present, so a page can say which fields it would fill
 * before one is chosen.
 */
export function fillPlanOf(manifest: KindsManifest, folder: string, options: { readonly selected?: readonly string[]; readonly lang?: string } = {}): FillPlanView {
  const language = options.lang === undefined || options.lang === '' ? 'en' : options.lang;
  const all = fillTargets(manifest, [...manifest.kinds.keys()]);
  const cataloguePlan = all.ok ? planOf(manifest, folder, all.targets.order) : { refusal: all.message };
  const agents = agentPluginsOf(manifest);
  const order = catalogueOrder(manifest);
  const catalogue = order.map((kind) => kindView(manifest, cataloguePlan.plan, kind, language, agents));
  const selected = [...new Set((options.selected ?? []).map((kind) => kind.trim()).filter((kind) => kind !== ''))];
  if (selected.length === 0) {
    return {
      order: [], kinds: [], catalogue, requiresAgent: false, unproduced: [],
      ...(cataloguePlan.refusal === undefined ? {} : { refusal: cataloguePlan.refusal }),
    };
  }
  const targets = readFillTargets(manifest, { entities: selected });
  if (!targets.ok) {
    // A kind the manifest does not declare is a refusal of the whole plan, not a silently smaller selection.
    return { order: [], kinds: [], catalogue, requiresAgent: false, unproduced: [], refusal: targets.message };
  }
  const planned = planOf(manifest, folder, targets.targets.order);
  const kinds = targets.targets.order.map((kind) => {
    const entry = targets.targets.entries.find((one) => one.kind === kind);
    const view = kindView(manifest, planned.plan, kind, language, agents);
    return { ...view, ...(entry === undefined ? {} : { reason: entry.reason, namedBy: entry.namedBy }) };
  });
  const unproduced = kinds.filter((kind) => kind.plugins.length === 0).map((kind) => kind.kind);
  return {
    order: targets.targets.order,
    kinds,
    catalogue,
    requiresAgent: kinds.some((kind) => kind.agent),
    unproduced,
    ...(planned.refusal === undefined ? {} : { refusal: planned.refusal }),
  };
}
