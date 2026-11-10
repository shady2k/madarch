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
import type { KindDecl, KindsManifest } from './kinds.js';
import type { CatalogKindView, KindProducer, WikiStatus } from './model.js';

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

/**
 * What produces one kind today, read from its declaration: a document kind from the documents stage, a kind of the
 * history from the history stage, a code kind from extraction, a page the agent keeps from the writer. A page a person
 * writes names the person, which is not a stage; a kind the declaration marks `not-implemented`, and a catalogue-only
 * kind whose acquisition names no extractor, are produced by nothing yet.
 */
function producerOf(decl: KindDecl | undefined, entry: CatalogEntry | undefined, extractorMark: string): KindProducer | undefined {
  if (entry?.status === 'not-implemented') return undefined;
  if (decl !== undefined) {
    if (decl.source === 'document') return 'documents';
    if (decl.origin === 'history') return 'history';
    if (decl.source === 'graph') return 'extract';
    return decl.origin === 'person' ? 'person' : 'writer';
  }
  if (entry === undefined) return undefined;
  const extractor = `${extractorMark} `;
  if (entry.acquisition.some((mark) => mark.startsWith(extractor) && mark.length > extractor.length)) return 'extract';
  if (entry.acquisition.includes('agent-from-graph')) return 'writer';
  return undefined;
}

/** Every kind the manifest declares, as the catalogue page lists it, in the manifest's order. */
/** About what one entity costs an agent to extract, in tokens: a definition, its evidence and the answer's framing. */
const TOKENS_PER_AGENT_ENTITY = 220;

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
 * Every kind the manifest declares, as the catalogue page lists it, in the manifest's order.
 */
export async function catalogKinds(ctx: RenderContext, turns: { readonly stateOf?: (kind: string) => string | undefined } = {}): Promise<CatalogKindView[]> {
  const numbers = await kindNumbers(ctx);
  const catalog = ctx.manifest.catalog;
  const pluginsOf = (decl: KindDecl | undefined): string[] => [...new Set((decl?.fields ?? []).flatMap((field) => (field.binding?.kind === 'plugin' ? [field.binding.plugin] : [])))].sort(byCodePoint);
  const row = (kind: string, area: string, subgroup: string, words: { labels?: Readonly<Record<string, { one: string; many: string }>>; descriptions?: Readonly<Record<string, string>> }, page: boolean, decl: KindDecl | undefined, entry: CatalogEntry | undefined, extractorMark: string): CatalogKindView => {
    const producer = producerOf(decl, entry, extractorMark);
    const plugins = pluginsOf(decl);
    const count = numbers.count(kind, decl?.source);
    const dependsOn = [...(decl?.dependsOn ?? [])].sort(byCodePoint);
    return {
      kind, area, subgroup,
      ...(words.labels === undefined || Object.keys(words.labels).length === 0 ? {} : { labels: { ...words.labels } }),
      ...(words.descriptions === undefined || Object.keys(words.descriptions).length === 0 ? {} : { descriptions: { ...words.descriptions } }),
      count,
      ...(numbers.statements.has(kind) ? { statements: numbers.statements.get(kind)! } : {}),
      page,
      ...(producer === undefined ? {} : { producer }),
      filled: producer !== undefined && producer !== 'person',
      ...(plugins.length === 0 ? {} : { plugins }),
      ...(dependsOn.length === 0 ? {} : { dependsOn }),
      state: stateOf(count, turns.stateOf?.(kind)),
      // A kind its own plugin fills needs no model: its answer costs no tokens (0035, items 22 and 23).
      estimatedTokens: plugins.length > 0 ? 0 : Math.max(count, 1) * TOKENS_PER_AGENT_ENTITY,
    };
  };
  if (catalog === undefined) {
    // A manifest written before the catalog declares only the kinds it shows: each stands where its group says, and the
    // catalogue is those kinds. The words a kind leaves out stay absent, as they are for the kind's own page.
    return [...ctx.manifest.kinds.values()].map((decl) => {
      const group = decl.group;
      const held = group === undefined ? undefined : ctx.manifest.groups.get(group);
      const area = held?.parent ?? group ?? '';
      const subgroup = held?.parent === undefined ? '' : group!;
      return row(decl.name, area, subgroup, { ...(decl.labels === undefined ? {} : { labels: decl.labels }), ...(decl.descriptions === undefined ? {} : { descriptions: decl.descriptions }) }, decl.member === undefined, decl, undefined, 'extractor');
    });
  }
  const extractorMark = catalog.schema.extractorMark;
  return [...catalog.kinds.values()].map((entry) => row(entry.name, entry.area, entry.subgroup, { labels: entry.labels, descriptions: entry.descriptions }, entry.templatePolicy === 'page' && ctx.manifest.kinds.has(entry.name), ctx.manifest.kinds.get(entry.name), entry, extractorMark));
}
