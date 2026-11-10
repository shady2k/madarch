/**
 * The numbers a kind's entities add up to (madarch-8bdc.2.5): the graph's entities per kind and the statements the
 * Markdown index holds. The graph is the one source: there is no second store to count the files from. The navigation, a kind's listing and the catalogue page all
 * state the same number, so it is read once here rather than counted three ways.
 */
import type { RenderContext } from './blocks.js';

/** One read of the entities per kind, split by where they are read from. */
export interface KindNumbers {
  /** The graph's entities per kind; the kind `code.file` is the record store's own count when the store answers it. */
  readonly graph: ReadonlyMap<string, number>;
  readonly markdown: ReadonlyMap<string, number>;
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
  const markdown = tally(ctx.markdown.values());
  // No stage of the fill writes the document kinds yet (decision 0033, item 1): the request-time reading is deleted, so a
  // document kind counts no entity until the stage that fills it exists.
  const statements = new Map((await ctx.index?.counts() ?? []).map((entry) => [entry.kind, entry.statements] as const));
  return {
    graph,
    markdown,
    statements,
    // A document kind's entities are written by the fill's plugins, so its count is the graph's too; a Markdown kind's is
    // the index's, and a kind no stage fills counts nothing.
    count: (kind, source) => source === 'markdown' ? markdown.get(kind) ?? 0 : graph.get(kind) ?? 0,
  };
}
