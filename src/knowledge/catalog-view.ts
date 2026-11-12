/**
 * The entity catalogue as its page reads it (madarch-8bdc.2.5): every kind the product's manifest declares, under its area
 * and its subgroup, with its name and description in each interface language, the entities that stand of it and what
 * produces it today. A kind no stage fills is listed with the count it holds — zero when nothing filled it yet — because
 * the catalogue is the product's full potential, not the part of it the wiki shows today.
 *
 * The words come from the kind's own declaration (its `labels` and `description`); the producer from its `source`, its
 * `origin` or the extractor its `acquisition` names, never from a list of kinds held here. A language the declaration
 * leaves out stays absent and its finding names the file and line; the app marks the kind untranslated rather than
 * showing an English name to a reader of another language.
 */
import { byCodePoint } from '../model/order.js';
import type { RenderContext } from './blocks.js';
import type { CatalogEntry } from './catalog.js';
import { kindNumbers } from './kind-numbers.js';
import { fillRequirementsOf } from './fill-requirements.js';
import type { KindDecl, KindsManifest } from '../product/manifest/kinds.js';
import type { CatalogKindView, CatalogSummaryView, CatalogView, WikiStatus } from './model.js';

/** The list carries navigation and fill metadata; declaration details are read only when a kind is opened. */
export function catalogSummary(view: CatalogView): CatalogSummaryView {
  return { ...view, kinds: view.kinds.map(({ fields, relations, sources, pluginFolders, declaration, filled, ...kind }) => ({
    ...kind,
    ...(sources === undefined || sources.length === 0 ? {} : { sourcesAvailable: true }),
  })) };
}

/** The groups of the navigation and the catalogue, in the manifest's order, as the app reads them. */
export function groupViews(manifest: KindsManifest): WikiStatus['groups'] {
  return [...manifest.groups.values()].map((group) => ({
    group: group.name,
    labels: { ...group.labels },
    ...(group.short === undefined ? {} : { short: { ...group.short } }),
    ...(group.parent === undefined ? {} : { parent: group.parent }),
    ...(group.open === undefined ? {} : { open: group.open }),
  }));
}

/** Every kind the manifest declares, as the catalogue page lists it, in the manifest's order. */
/** What one kind's fill stands as (madarch-stm0.6): filled, partial, or never filled. */
export type KindFillState = 'filled' | 'partial' | 'never';

/**
 * The fill state of one kind, from the entities the graph holds and the state of the kind's newest turn:
 * 'never' when nothing of it stands, 'partial' when its last turn did not publish (failed, blocked, cancelled, or not
 * reached), and 'filled' otherwise. A kind with no turn at all — one the agent fills, or the person writes — is judged
 * by what the graph holds alone.
 */
function stateOf(count: number, turn: string | undefined): KindFillState {
  if (count === 0) return 'never';
  return turn === undefined || turn === 'published' || turn === 'superseded' ? 'filled' : 'partial';
}

/**
 * One kind's estimate (madarch-stm0.6): the volume the graph measures times the per-unit figure its producer declares.
 * The volume is the count of the kind's vertices when the kind has a table — a kind with none has no measured volume,
 * which is `null` and not zero. No producer declares a per-unit figure today: a plugin's introduction will carry one
 * (its own tokens and time per unit, the plugin protocol's next version), and the agent plugin will carry the agent's;
 * until one does, both figures are `null` and the cost is unknown, which the panel says instead of guessing.
 */
function estimateOf(count: number, generated: boolean | undefined, measured: number | undefined): NonNullable<CatalogKindView['estimate']> {
  const volume = generated === true ? (measured ?? count) : null;
  const tokensPerUnit: number | null = null;
  const secondsPerUnit: number | null = null;
  return {
    volume, unit: 'vertices', tokensPerUnit, secondsPerUnit,
    tokens: volume === null || tokensPerUnit === null ? null : volume * tokensPerUnit,
    seconds: volume === null || secondsPerUnit === null ? null : volume * secondsPerUnit,
  };
}

/** Relations come from endpoint declarations, kind key patterns and catalogue constraints, never observed guesses. */
function relationsOf(ctx: RenderContext, kind: string): NonNullable<CatalogKindView['relations']> {
  const rows: { direction: 'out' | 'in'; name: string; kind?: string }[] = [];
  const add = (direction: 'out' | 'in', name: string, peer?: string): void => {
    if (!rows.some((row) => row.direction === direction && row.name === name && row.kind === peer)) {
      rows.push({ direction, name, ...(peer === undefined ? {} : { kind: peer }) });
    }
  };
  for (const edge of ctx.manifest.edges?.values() ?? []) {
    if (edge.from.includes(kind)) for (const peer of edge.to) add('out', edge.name, peer);
    if (edge.to.includes(kind)) for (const peer of edge.from) add('in', edge.name, peer);
  }
  for (const decl of ctx.manifest.kinds.values()) {
    for (const relation of decl.relations) {
      const prefix = relation.to.slice(0, relation.to.indexOf(':'));
      const peer = relation.to.includes(':') && (ctx.manifest.kinds.has(prefix) || ctx.manifest.catalog?.kinds.has(prefix)) ? prefix : undefined;
      if (decl.name === kind) add('out', relation.type, peer);
      if (peer === kind) add('in', relation.type, decl.name);
    }
  }
  const entry = ctx.manifest.catalog?.kinds.get(kind);
  for (const direction of ['out', 'in'] as const) {
    const constraints = (direction === 'out' ? entry?.relationsOut : entry?.relationsIn) ?? [];
    for (const name of constraints) if (!rows.some((row) => row.direction === direction && row.name === name)) add(direction, name);
  }
  return rows;
}

/**
 * Every kind the manifest declares, as the catalogue page lists it, in the manifest's order.
 */
export async function catalogKinds(ctx: RenderContext, turns: {
  /** The newest generation of the kind's plugin turn, as the store's machine names it; absent when it never ran. */
  readonly turnOf?: (kind: string) => string | undefined;
  /** Whether the store holds a table of the kind, so its volume is measured rather than unknown. */
  readonly generatedOf?: (kind: string) => boolean;
} = {}): Promise<CatalogKindView[]> {
  const numbers = await kindNumbers(ctx);
  const catalog = ctx.manifest.catalog;
  const requirementOf = fillRequirementsOf(ctx.manifest, ctx.productFolder);
  const pluginsOf = (decl: KindDecl | undefined): string[] => decl === undefined ? [] : [...(ctx.manifest.plugins?.values() ?? [])].filter((plugin) => plugin.declaration?.produces.some((output) => output.kind === '*' || output.kind === decl.name)).map((plugin) => plugin.id).sort(byCodePoint);
  const row = (kind: string, subgroup: string, words: { labels?: Readonly<Record<string, { one: string; many: string }>>; descriptions?: Readonly<Record<string, string>> }, page: boolean, decl: KindDecl | undefined, entry: CatalogEntry | undefined): CatalogKindView => {
    const plugins = pluginsOf(decl);
    const pluginFolders = [...new Set(plugins.flatMap((id) => {
      const path = ctx.manifest.plugins?.get(id)?.path;
      return path === undefined ? [] : [path];
    }))].sort(byCodePoint);
    const count = numbers.count(kind, decl?.source);
    const derivesFrom = [...(decl?.derivesFrom ?? [])].sort(byCodePoint);
    const turn = turns.turnOf?.(kind);
    const estimate = estimateOf(count, turns.generatedOf?.(kind), count);
    return {
      kind, subgroup,
      ...(decl === undefined ? {} : requirementOf([kind])),
      declaration: { file: ctx.manifest.file, line: decl?.line ?? entry!.line },
      fields: (decl?.details ?? []).flatMap((name) => {
        const property = ctx.manifest.properties.get(name);
        if (property === undefined) return [];
        const field = decl?.fields?.find((field) => field.name === name);
        const binding = field?.binding;
        const meaning = binding?.kind === 'agent' ? binding.description
          : binding?.kind === 'plugin' ? ctx.manifest.plugins?.get(binding.plugin)?.contract?.vertices
            .find((vertex) => vertex.kind === kind)?.fields.find((field) => field.name === binding.field)?.meaning
          : undefined;
        return [{ name, labels: { ...property.labels },
          ...(meaning === undefined ? {} : { meaning }),
          ...(field?.reference === undefined ? {} : { reference: field.reference }),
          declaration: { file: ctx.manifest.file, line: property.line } }];
      }),
      relations: relationsOf(ctx, kind),
      ...(entry === undefined ? {} : { sources: [...entry.sources] }),
      ...(words.labels === undefined || Object.keys(words.labels).length === 0 ? {} : { labels: { ...words.labels } }),
      ...(words.descriptions === undefined || Object.keys(words.descriptions).length === 0 ? {} : { descriptions: { ...words.descriptions } }),
      count,
      ...(numbers.statements.has(kind) ? { statements: numbers.statements.get(kind)! } : {}),
      page,
      filled: count > 0,
      ...(plugins.length === 0 ? {} : { plugins }),
      ...(pluginFolders.length === 0 ? {} : { pluginFolders }),
      ...(derivesFrom.length === 0 ? {} : { derivesFrom }),
      ...(turn === undefined ? {} : { turn }),
      state: stateOf(count, turn),
      ...(estimate.tokens === null && estimate.seconds === null ? {} : { estimate }),
    };
  };
  if (catalog === undefined) {
    // A manifest written before the catalog declares only the kinds it shows: each stands where its group says, and the
    // catalogue is those kinds. The words a kind leaves out stay absent, as they are for the kind's own page.
    return [...ctx.manifest.kinds.values()].map((decl) => {
      const group = decl.group;
      const held = group === undefined ? undefined : ctx.manifest.groups.get(group);
      const subgroup = held?.parent === undefined ? '' : group!;
      return row(decl.name, subgroup, { ...(decl.labels === undefined ? {} : { labels: decl.labels }), ...(decl.descriptions === undefined ? {} : { descriptions: decl.descriptions }) }, decl.member === undefined, decl, undefined);
    });
  }
  return [...catalog.kinds.values()].map((entry) => row(entry.name, entry.subgroup, { labels: entry.labels, descriptions: entry.descriptions }, entry.templatePolicy === 'page' && ctx.manifest.kinds.has(entry.name), ctx.manifest.kinds.get(entry.name), entry));
}
