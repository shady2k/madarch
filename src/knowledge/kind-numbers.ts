/**
 * The numbers a kind's entities add up to (madarch-8bdc.2.5): the graph's entities per kind, the files the record store
 * published, and the statements the Markdown index holds. The navigation, a kind's listing and the catalogue page all
 * state the same number, so it is read once here rather than counted three ways.
 */
import type { RenderContext } from './blocks.js';

/** One read of the entities per kind, split by where they are read from. */
export interface KindNumbers {
  /** The graph's entities per kind; the kind `code.file` is the record store's own count when the store answers it. */
  readonly graph: ReadonlyMap<string, number>;
  readonly markdown: ReadonlyMap<string, number>;
  readonly documents: ReadonlyMap<string, number>;
  /** The statements per page kind, from the Markdown index; absent kinds make none. */
  readonly statements: ReadonlyMap<string, number>;
  /** The entities of one kind: the pool its declaration's `source` names, the graph when it names none. */
  count(kind: string, source?: 'graph' | 'markdown' | 'document'): number;
}

/** The entities per kind of one pool, in the order the pool holds them. */
function tally(entities: Iterable<{ readonly kind: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entity of entities) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  return counts;
}

/** The counts every screen that names a kind's entities states, read once. */
export async function kindNumbers(ctx: RenderContext): Promise<KindNumbers> {
  const graph = new Map((await ctx.graph.kindCounts()).map((entry) => [entry.kind, entry.count] as const));
  // The record store's files are the kind `code.file`'s entities in a store this fill wrote (madarch-8bdc.2.5): the
  // count the navigation and the catalogue show is the store's own, so the two never disagree about where the files are.
  if (ctx.records !== undefined) graph.set('code.file', await ctx.records.files.count());
  const markdown = tally(ctx.markdown.values());
  const documents = tally(ctx.docEntities.values());
  const statements = new Map((await ctx.index?.counts() ?? []).map((entry) => [entry.kind, entry.statements] as const));
  return {
    graph,
    markdown,
    documents,
    statements,
    count: (kind, source) => source === 'markdown' ? markdown.get(kind) ?? 0 : source === 'document' ? documents.get(kind) ?? 0 : graph.get(kind) ?? 0,
  };
}
