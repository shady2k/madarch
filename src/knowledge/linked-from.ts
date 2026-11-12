/**
 * The `linkedfrom` block (madarch-ztyq.8): the product's pages whose prose grounds a
 * statement in an entity or links to it, and — for a graph page — every statement the
 * index of the Markdown knows to rely on its key. Every row is a fact of a file, and an
 * empty list is drawn only where the template asks for it.
 */
import { byCodePoint } from '../model/order.js';
import { refOfMarkdown, type RenderContext, type Subject } from './blocks.js';
import type { Block, RefRow } from './model.js';

/** The most rows a list of references shows. */
const REFS_LIMIT = 50;

export async function linkedFromBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>): Promise<Block> {
  const title = params['title'] ?? 'Linked from';
  // A graph page lists the pages whose prose mentions it (madarch-ztyq.8): the core inserts those links, and the index
  // knows every statement that grounds or mentions the key. Before, a graph page had only its related block.
  const graphKey = subject.source === 'graph' ? subject.entity.key : undefined;
  const id = subject.source === 'graph' ? subject.entity.key : subject.entity.id;
  const rows = new Map<string, RefRow>();
  // 1. The product's pages that ground a statement in this entity or link to it.
  for (const page of [...ctx.markdown.values()].sort((a, b) => byCodePoint(a.id, b.id))) {
    if (page.id === id) continue;
    const reading = page.statementReading;
    let statements = 0;
    for (const statement of reading.statements) {
      const urls = statement.notes.flatMap((note) => reading.definitions.get(note) ?? []);
      const resolved = await Promise.all(urls.map((url) => ctx.resolver.resolve(url)));
      if (resolved.some((resolution) => resolution.state === 'ok' && resolution.entity === id)) statements += 1;
    }
    let linked = statements > 0;
    if (!linked) {
      for (const target of page.mentions) {
        const resolution = await ctx.resolver.resolve(`madarch:${target}`);
        if (resolution.state === 'ok' && resolution.entity === id) { linked = true; break; }
      }
    }
    if (linked) rows.set(page.id, statements > 0
      ? { entity: refOfMarkdown(ctx, page), note: `${statements} statement${statements === 1 ? '' : 's'} grounded in it`, noteKey: 'statements', noteArgs: { count: statements } }
      : { entity: refOfMarkdown(ctx, page), note: 'links to it', noteKey: 'links' });
  }
  // 2. The statements of the index that rely on this key (the index sees the page's footnotes whole).
  if (graphKey !== undefined && ctx.index !== undefined) {
    const relied = await ctx.index.relyingOn(graphKey);
    for (const relying of relied) {
      const page = ctx.markdown.get(relying.page);
      if (page === undefined || rows.has(page.id)) continue;
      const count = relied.filter((other) => other.page === relying.page).length;
      rows.set(page.id, { entity: refOfMarkdown(ctx, page), note: `${count} statement${count === 1 ? '' : 's'} ${relying.how === 'grounds' ? 'grounded in it' : 'mention it'}`, noteKey: 'statements', noteArgs: { count } });
    }
  }
  const ordered = [...rows.values()].sort((a, b) => byCodePoint(a.entity.id, b.entity.id));
  return { type: 'refs', title, total: ordered.length, rows: ordered.slice(0, REFS_LIMIT), ...(params['hide-empty'] === 'true' ? { hideEmpty: true } : {}) };
}
