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
import type { GraphEntity } from './graph-read.js';
import type { Block, HistoryFigure, HistoryNote, HistoryRow, HistorySection } from './model.js';
import { refOfGraph, type RenderContext, type Subject } from './blocks.js';
import { projectHistory } from './history-evidence.js';

/** The kinds the history block tells the story of. */
export const HISTORY_KINDS: ReadonlySet<string> = new Set(['code.task', 'code.commit', 'code.author', 'code.repository', 'code.file', 'code.module', 'code.service', 'code.package']);

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
async function taskRows(ctx: RenderContext, task: GraphEntity, limit: number): Promise<{ sections: HistorySection[]; notes: HistoryNote[] }> {
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
  const notes: HistoryNote[] = found.total > rows.length ? [{key: 'manyCommits', args: {total: found.total, shown: rows.length}}] : [];
  return { sections: rows.length === 0 ? [] : [{ role: 'commits', total: found.total, rows }], notes };
}

/** The files one commit changed, each with the lines it added and removed and the symbols the file declares. */
async function commitRows(ctx: RenderContext, commit: GraphEntity, limit: number): Promise<{ sections: HistorySection[]; notes: HistoryNote[] }> {
  const found = await ctx.graph.edgesOf(commit, 'code.touched', 'out', limit);
  const rows: HistoryRow[] = [];
  let uncounted = 0;
  const notes: HistoryNote[] = [];
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
    if (declared !== undefined && declared.total > declared.rows.length) notes.push({key: 'symbolsCut', args: {path: file.label, shown: declared.rows.length}});
  }
  if (found.total > rows.length) notes.push({key: 'manyFiles', args: {total: found.total, shown: rows.length}});
  if (uncounted > 0) notes.push({key: 'noCounts', args: {count: uncounted}});
  if (found.total === 0) notes.push({key: commit.properties['merge'] === true ? 'merge' : 'noFiles'});
  return { sections: rows.length === 0 ? [] : [{ role: 'files', total: found.total, rows }], notes };
}

/** The history block: the story of a task, a commit or an author, from the graph's own facts. */
export async function historyBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const title = params['title'] ?? 'History';
  const limit = toInt(params['limit'], 100, 1, 500);
  if (subject.source !== 'graph') {
    if (subject.source !== 'markdown' || subject.entity.kind !== 'product') return { type: 'problem', block: 'history', file, line, message: `${ctx.productFolder}/${file}:${line}: the history block reads indexed repository evidence, not this ${subject.entity.kind} page` };
    const sections: HistorySection[] = [];
    const notes: HistoryNote[] = [];
    for (const repository of await ctx.graph.repositories()) {
      const projected = projectHistory(await ctx.graph.historyEvidence(repository.nodeId), undefined, limit, (one) => refOfGraph(ctx, one));
      sections.push(...projected.sections.map((section) => ({ ...section, repository: ctx.repoOfScope(repository.nodeId) ?? repository.path })));
      notes.push(...projected.notes);
    }
    return { type: 'history', title, sections, notes };
  }
  const entity = subject.entity;
  let built = entity.kind === 'code.task' ? await taskRows(ctx, entity, limit) : entity.kind === 'code.commit' ? await commitRows(ctx, entity, limit) : undefined;
  if (HISTORY_KINDS.has(entity.kind) && entity.kind !== 'code.task') {
    const projected = projectHistory(await ctx.graph.historyEvidence(entity.scope), entity, limit, (one) => refOfGraph(ctx, one));
    built = { sections: [...(built?.sections ?? []), ...projected.sections], notes: [...(built?.notes ?? []), ...projected.notes] };
  }
  if (built === undefined) {
    return { type: 'problem', block: 'history', file, line, message: `the history block tells the story of a task, a commit or an author, and this page is a ${entity.kind}: use the related block for its relations` };
  }
  return { type: 'history', title, sections: built.sections, notes: built.notes };
}
