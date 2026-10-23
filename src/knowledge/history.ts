/**
 * The history block (madarch-m38l.16): what a task, a commit or an author did,
 * read from the graph's own history facts — the commits a task's key names in
 * their messages, the files a commit touched with the lines it added and
 * removed, and the commits and the most-touched files of one author. A kind
 * the block has nothing to say about gets a `problem` block that names the
 * kinds it serves, never an empty list that looks complete.
 *
 * Every list is bounded by the block's `limit` and says its total, and every
 * figure the block shows comes from an edge or a property of the graph: no
 * page read runs Git.
 */
import { byCodePoint } from '../model/order.js';
import type { GraphEntity } from './graph-read.js';
import type { Block, HistoryFigure, HistoryRow, HistorySection } from './model.js';
import { refOfGraph, type RenderContext, type Subject } from './blocks.js';

/** The kinds the history block tells the story of. */
export const HISTORY_KINDS: ReadonlySet<string> = new Set(['code.task', 'code.commit', 'code.author']);

const toInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/** The day a commit happened, as the page shows it: the date of its effective time, in UTC. */
export function dayOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 10) return undefined;
  return value.slice(0, 10);
}

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The figures of one touched edge: the lines it added and removed, where the history walk counted them. */
function churnOf(properties: Record<string, unknown>): HistoryFigure[] {
  const added = numberOf(properties['additions']);
  const removed = numberOf(properties['deletions']);
  return [
    ...(added === undefined ? [] : [{ kind: 'added' as const, value: String(added) }]),
    ...(removed === undefined ? [] : [{ kind: 'removed' as const, value: String(removed) }]),
  ];
}

/** The commit rows of one task: its commits with the day, the author and the message each carries. */
async function taskRows(ctx: RenderContext, task: GraphEntity, limit: number): Promise<{ sections: HistorySection[]; notes: string[] }> {
  const found = await ctx.graph.edgesOf(task, 'code.tasks', 'in', limit);
  const rows: HistoryRow[] = [];
  for (const edge of found.rows) {
    const commit = edge.other;
    const [author] = await ctx.graph.neighbors(commit, { relations: ['code.authored'], direction: 'in', limit: 1 });
    rows.push({
      ...(dayOf(commit.properties['effectiveAt'] ?? commit.properties['committedAt']) === undefined ? {} : { when: dayOf(commit.properties['effectiveAt'] ?? commit.properties['committedAt'])! }),
      ...(author?.rows[0] === undefined ? {} : { who: author.rows[0].entity.label }),
      text: commit.label,
      entity: refOfGraph(ctx, commit),
      figures: [],
    });
  }
  const notes = found.total > rows.length ? [`The task names ${String(found.total)} commits; this page shows the first ${String(rows.length)}.`] : [];
  return { sections: rows.length === 0 ? [] : [{ role: 'commits', total: found.total, rows }], notes };
}

/** The files one commit changed, each with the lines it added and removed and the symbols the file declares. */
async function commitRows(ctx: RenderContext, commit: GraphEntity, limit: number): Promise<{ sections: HistorySection[]; notes: string[] }> {
  const found = await ctx.graph.edgesOf(commit, 'code.touched', 'out', limit);
  const rows: HistoryRow[] = [];
  let uncounted = 0;
  const notes: string[] = [];
  for (const edge of found.rows) {
    const file = edge.other;
    const churn = churnOf(edge.properties);
    if (churn.length === 0) uncounted += 1;
    const contained = await ctx.graph.neighbors(file, { relations: ['code.contains'], direction: 'out', limit: 500 });
    const declared = contained.find((group) => group.relation === 'code.contains');
    const symbols = declared?.rows.filter((row) => row.entity.kind === 'code.symbol') ?? [];
    const symbolCount = symbols.length;
    rows.push({
      text: file.label,
      entity: refOfGraph(ctx, file),
      figures: [...churn, ...(symbolCount === 0 ? [] : [{ kind: 'symbols' as const, value: String(symbolCount) }])],
    });
    if (declared !== undefined && declared.total > declared.rows.length) notes.push(`The file ${file.label} has more than ${String(declared.rows.length)} contained entities; its symbol count is incomplete.`);
  }
  if (found.total > rows.length) notes.push(`The commit changed ${String(found.total)} files; this page shows the first ${String(rows.length)}.`);
  if (uncounted > 0) notes.push(`${String(uncounted)} of the files report no line counts: the history walk counts the lines of text, and a binary file has none.`);
  if (found.total === 0) notes.push('This commit changed no file of its own: it is a merge, and the changes came in with the branches it brought together.');
  return { sections: rows.length === 0 ? [] : [{ role: 'files', total: found.total, rows }], notes };
}

/** The commits of one author, then the files those commits touched most, each with its module. */
async function authorRows(ctx: RenderContext, author: GraphEntity, limit: number): Promise<{ sections: HistorySection[]; notes: string[] }> {
  const found = await ctx.graph.edgesOf(author, 'code.authored', 'out', limit);
  const commits: HistoryRow[] = found.rows.map((edge) => ({
    ...(dayOf(edge.other.properties['effectiveAt'] ?? edge.other.properties['committedAt']) === undefined ? {} : { when: dayOf(edge.other.properties['effectiveAt'] ?? edge.other.properties['committedAt'])! }),
    text: edge.other.label,
    entity: refOfGraph(ctx, edge.other),
    figures: [],
  }));
  const files = new Map<string, { entity: GraphEntity; commits: number; added: number; removed: number }>();
  for (const edge of found.rows) {
    const touched = await ctx.graph.edgesOf(edge.other, 'code.touched', 'out', 500);
    for (const one of touched.rows) {
      const held = files.get(one.other.key) ?? { entity: one.other, commits: 0, added: 0, removed: 0 };
      held.commits += 1;
      held.added += numberOf(one.properties['additions']) ?? 0;
      held.removed += numberOf(one.properties['deletions']) ?? 0;
      files.set(one.other.key, held);
    }
  }
  const top = [...files.values()].sort((left, right) => right.commits - left.commits || left.added + left.removed - (right.added + right.removed) || byCodePoint(left.entity.key, right.entity.key)).slice(0, Math.min(10, limit));
  const notes: string[] = [];
  const topRows: HistoryRow[] = [];
  for (const file of top) {
    const modules = await ctx.graph.neighbors(file.entity, { relations: ['code.contains'], direction: 'in', limit: 5 });
    const module = modules.flatMap((group) => group.rows).map((row) => row.entity).find((entity) => entity.kind === 'code.module');
    topRows.push({
      text: file.entity.label,
      entity: refOfGraph(ctx, file.entity),
      figures: [
        { kind: 'commits', value: String(file.commits) },
        ...(file.added + file.removed === 0 ? [] : [{ kind: 'added' as const, value: String(file.added) }, { kind: 'removed' as const, value: String(file.removed) }]),
        ...(module === undefined ? [] : [{ kind: 'module' as const, value: module.label }]),
      ],
    });
  }
  if (found.total > found.rows.length) notes.push(`The author made ${String(found.total)} commits; the files below count the ${String(found.rows.length)} shown, and no line counts for a file the walk did not count.`);
  const sections: HistorySection[] = [];
  if (commits.length > 0) sections.push({ role: 'commits', total: found.total, rows: commits });
  if (topRows.length > 0) sections.push({ role: 'files', total: topRows.length, rows: topRows });
  return { sections, notes };
}

/** The history block: the story of a task, a commit or an author, from the graph's own facts. */
export async function historyBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const title = params['title'] ?? 'History';
  const limit = toInt(params['limit'], 100, 1, 500);
  if (subject.source !== 'graph') {
    return { type: 'problem', block: 'history', file, line, message: `the history block reads the graph, and this page is ${subject.source === 'markdown' ? 'a Markdown page' : 'a document'}: no history of it is read` };
  }
  const entity = subject.entity;
  const built = entity.kind === 'code.task' ? await taskRows(ctx, entity, limit) : entity.kind === 'code.commit' ? await commitRows(ctx, entity, limit) : entity.kind === 'code.author' ? await authorRows(ctx, entity, limit) : undefined;
  if (built === undefined) {
    return { type: 'problem', block: 'history', file, line, message: `the history block tells the story of a task, a commit or an author, and this page is a ${entity.kind}: use the related block for its relations` };
  }
  return { type: 'history', title, sections: built.sections, notes: built.notes };
}
