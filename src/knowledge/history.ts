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
import { kindAddress } from './addresses.js';
import type { GraphEntity } from './graph-read.js';
import { HISTORY_SHAPES, type HistoryShape } from '../product/manifest/kinds.js';
import { GIT_WIKI } from '../fill/stages/git-contract.js';
import type { Block, HistoryFigure, HistoryNote, HistoryRow, HistorySection } from './model.js';
import { refOfGraph, type RenderContext, type Subject } from './blocks.js';
import { projectHistory, projectHistoryAcross } from './history-evidence.js';
import { withSpan } from '../obs/trace.js';

/** The shape of the history page a kind declares (`history:` of its declaration), or none. */
function historyShapeOf(ctx: RenderContext, kind: string): HistoryShape | undefined {
  return ctx.manifest.kinds.get(kind)?.history;
}

/**
 * The kinds of list the block can build, in the order it builds them. A template asks for the ones it wants with
 * `sections="summary,hotspots"`, so a page that is meant to be read in a minute carries the whole story elsewhere.
 */
const HISTORY_SECTIONS: readonly HistorySection['role'][] = ['summary', 'hotspots', 'commits', 'files', 'authors', 'coupling', 'renames', 'parents', 'branches', 'snapshots'];

const toInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/** The day a commit happened, as the page shows it: the date of its effective time, in UTC. */
function dayOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 10) return undefined;
  return value.slice(0, 10);
}

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * The figures of one touched edge: what the commit did to the file, and the lines it added and removed. The one
 * graph's touched edge holds `change`, `added` and `removed`; a store filled by the old walk holds `additions` and
 * `deletions`, and both are read so an older store's rows say what they said.
 */
function churnOf(properties: Record<string, unknown>): HistoryFigure[] {
  const change = typeof properties['change'] === 'string' ? properties['change'] : undefined;
  const added = numberOf(properties['added']) ?? numberOf(properties['additions']);
  const removed = numberOf(properties['removed']) ?? numberOf(properties['deletions']);
  return [
    ...(change === undefined ? [] : [{ kind: 'change' as const, value: change }]),
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
    const [author] = await ctx.graph.neighbors(commit, { relations: [GIT_WIKI.authored], direction: 'in', limit: 1 });
    rows.push({
      ...(dayOf(commit.properties['effectiveAt'] ?? commit.properties['committedAt']) === undefined ? {} : { when: dayOf(commit.properties['effectiveAt'] ?? commit.properties['committedAt'])! }),
      ...(author?.rows[0] === undefined ? {} : { who: String(author.rows[0].entity.properties['name'] ?? author.rows[0].entity.label) }),
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
  const found = await ctx.graph.commitChanged(commit, limit);
  const rows: HistoryRow[] = [];
  let uncounted = 0;
  for (const file of found.rows) {
    const churn = churnOf({ change: file.change, added: file.added, removed: file.removed });
    if (churn.length === 0) uncounted += 1;
    if (file.previousPath !== null) churn.push({ kind: 'renamed', value: file.previousPath });
    rows.push({
      text: file.entity.label,
      entity: refOfGraph(ctx, file.entity),
      figures: [...churn, ...(file.symbols === 0 ? [] : [{ kind: 'symbols' as const, value: String(file.symbols) }])],
    });
  }
  const notes: HistoryNote[] = [];
  if (found.total > rows.length) notes.push({ key: 'manyFiles', args: { total: found.total, shown: rows.length } });
  if (uncounted > 0) notes.push({ key: 'noCounts', args: { count: uncounted } });
  if (found.total === 0) notes.push({ key: commit.properties['merge'] === true ? 'merge' : 'noFiles' });
  return { sections: rows.length === 0 ? [] : [{ role: 'files', total: found.total, rows }], notes };
}

/**
 * The sections the template asked for, or every section the block built. A name the block has no section of is a
 * problem that says which names it reads, never a silently shorter page.
 */
function keptSections(sections: readonly HistorySection[], wanted: string | undefined): HistorySection[] | string {
  if (wanted === undefined) return [...sections];
  const names = wanted.split(',').map((name) => name.trim()).filter((name) => name !== '');
  for (const name of names) {
    if (!HISTORY_SECTIONS.includes(name as HistorySection['role'])) return `"${name}" is not a section of the history block: it reads ${HISTORY_SECTIONS.join(', ')}`;
  }
  return sections.filter((section) => names.includes(section.role));
}

/**
 * Where the rest of the story lives, when the template names a kind (`more-kind`): the kind's listing, and the words
 * the link says it in — the template's `more`, else the manifest's own name for the kind in the reader's language.
 */
function moreOf(ctx: RenderContext, params: Readonly<Record<string, string>>, lang: string | undefined): { href: string; label: string } | string | undefined {
  const kind = params['more-kind'];
  if (kind === undefined) return undefined;
  const decl = ctx.manifest.kinds.get(kind);
  if (decl === undefined) return `the manifest ${ctx.manifest.file} declares no kind "${kind}": the history block cannot say where its rest lives`;
  const label = params['more'] ?? decl.labels?.[lang ?? ctx.language]?.many ?? kind;
  return { href: kindAddress(kind), label };
}

/** The history block: the story of a task, a commit or an author, from the graph's own facts. */
export async function historyBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number, lang?: string): Promise<Block> {
  const title = params['title'] ?? 'History';
  const limit = toInt(params['limit'], 100, 1, 500);
  const more = moreOf(ctx, params, lang);
  if (typeof more === 'string') return { type: 'problem', block: 'history', file, line, message: more };
  if (subject.source !== 'graph') {
    // A Markdown page's story is every repository of the product, when its kind declares that shape.
    if (subject.source !== 'markdown' || historyShapeOf(ctx, subject.entity.kind) !== 'repositories') return { type: 'problem', block: 'history', file, line, message: `${ctx.productFolder}/${file}:${line}: the history block reads indexed repository evidence, and the manifest ${ctx.manifest.file} declares no "history: repositories" for the kind ${subject.entity.kind} of this page` };
    const repositories = await ctx.graph.repositories();
    // The rest of a product's home page is bounded once, across all its repositories (madarch-ztyq.7): twenty
    // repositories cannot turn a five-row budget into twenty summaries and a hundred hotspots. One repository keeps
    // its label; a product-wide story says no single repository's name.
    const projected = projectHistoryAcross(await Promise.all(repositories.map((repository) => (ctx.historyEvidence ?? ((scope: string) => ctx.graph.historyEvidence(scope)))(repository.nodeId))), limit, (one) => refOfGraph(ctx, one));
    const sections: HistorySection[] = projected.sections.map((section) => repositories.length === 1
      ? { ...section, repository: ctx.repoOfScope(repositories[0]!.nodeId) ?? repositories[0]!.path }
      : section);
    const notes: HistoryNote[] = projected.notes;
    const kept = keptSections(sections, params['sections']);
    if (typeof kept === 'string') return { type: 'problem', block: 'history', file, line, message: kept };
    return { type: 'history', title, sections: kept, notes, ...(more === undefined ? {} : { more }) };
  }
  const entity = subject.entity;
  const shape = historyShapeOf(ctx, entity.kind);
  if (shape === undefined) {
    return { type: 'problem', block: 'history', file, line, message: `the history block tells the story of a kind whose declaration names it ("history: ${HISTORY_SHAPES.join(' | ')}"), and the manifest ${ctx.manifest.file} declares none for the kind ${entity.kind}: use the related block for its relations` };
  }
  // A task's story is the commits that name it, and a commit's own rows (the files it changed) stand before its
  // projection; every other shape is the projection alone.
  const rows = shape === 'task' ? await taskRows(ctx, entity, limit) : shape === 'commit' ? await commitRows(ctx, entity, limit) : { sections: [], notes: [] };
  let projected: { sections: HistorySection[]; notes: HistoryNote[] };
  if (shape === 'repositories') {
    const held = await ctx.graph.repositoryHistory(entity.scope, limit);
    const sections: HistorySection[] = [];
    if (held.commits > 0) sections.push({ role: 'summary', total: 1, rows: [{ text: '', figures: [
      { kind: 'reachable', value: String(held.commits) },
      { kind: 'firstParent', value: String(held.firstParent) },
      { kind: 'merges', value: String(held.merges) },
      { kind: 'nonMerge', value: String(held.nonMerge) },
      { kind: 'authors', value: String(held.authors) },
      ...(held.since === undefined || held.until === undefined ? [] : [{ kind: 'since' as const, value: held.since }, { kind: 'until' as const, value: held.until }]),
    ] }] });
    if (held.hotspots.length > 0) sections.push({ role: 'hotspots', total: held.hotspotsTotal, rows: held.hotspots.map((one) => ({ text: one.entity.label, entity: refOfGraph(ctx, one.entity), figures: [{ kind: 'commits', value: String(one.commits) }] })) });
    if (held.authorRows.length > 0) sections.push({ role: 'authors', total: held.authorsTotal, rows: held.authorRows.map((one) => ({ text: one.entity.label, entity: refOfGraph(ctx, one.entity), figures: [{ kind: 'commits', value: String(one.commits) }] })) });
    projected = { sections, notes: [{ key: 'population' }] };
  } else if (shape === 'commit') {
    const parents = await ctx.graph.commitParents(entity);
    const parentRows: HistoryRow[] = parents.map((one) => ({
      text: one.entity.label, entity: refOfGraph(ctx, one.entity), when: one.when,
      ...(one.who === undefined ? {} : { who: one.who }),
      figures: [
        { kind: 'files', value: String(one.files) },
        ...(one.added === 0 ? [] : [{ kind: 'added' as const, value: String(one.added) }]),
        ...(one.removed === 0 ? [] : [{ kind: 'removed' as const, value: String(one.removed) }]),
      ],
    }));
    const branches = entity.properties['merge'] === true ? await ctx.graph.commitBranches(entity, limit) : [];
    const summary: HistoryRow = { text: '', figures: (['authoredAt', 'committedAt', 'effectiveAt'] as const).flatMap((kind) => typeof entity.properties[kind] === 'string' ? [{ kind, value: String(entity.properties[kind]) }] : []) };
    const notes: HistoryNote[] = [];
    const first = parents[0];
    if (first !== undefined && String(entity.properties['committedAt']) <= String(first.entity.properties['effectiveAt'])) notes.push({ key: 'dateAnomaly', args: { parent: String(first.entity.properties['effectiveAt']) } });
    if (entity.properties['merge'] === true && typeof entity.properties['mergedBranch'] === 'string' && typeof entity.properties['effectiveAt'] === 'string') notes.push({ key: 'mergeBranch', args: { branch: entity.properties['mergedBranch'], date: entity.properties['effectiveAt'].slice(0, 10) } });
    projected = { sections: [
      ...(parentRows.length === 0 ? [] : [{ role: 'parents' as const, total: parentRows.length, rows: parentRows }]),
      { role: 'summary' as const, total: 1, rows: [summary] },
      ...(branches.length === 0 ? [] : [{ role: 'branches' as const, total: branches.length, rows: branches.map((one) => ({ text: one.entity.label, entity: refOfGraph(ctx, one.entity), when: one.when, ...(one.who === undefined ? {} : { who: one.who }), figures: [] })) }]),
    ], notes };
  } else {
    projected = shape === 'task' ? { sections: [], notes: [] } : projectHistory(
      shape === 'path' || shape === 'author'
        ? typeof ctx.graph.historyEvidenceFor === 'function'
          ? await ctx.graph.historyEvidenceFor(entity, shape, limit)
          : await ctx.graph.historyEvidence(entity.scope)
        : await withSpan('wiki.history.evidence', { 'wiki.history.scope': entity.scope }, async () => await (ctx.historyEvidence ?? ((scope: string) => ctx.graph.historyEvidence(scope)))(entity.scope)),
      entity, shape, limit, (one) => refOfGraph(ctx, one),
    );
  }
  const built: { sections: HistorySection[]; notes: HistoryNote[] } = { sections: [...rows.sections, ...projected.sections], notes: [...rows.notes, ...projected.notes] };
  const kept = keptSections(built.sections, params['sections']);
  if (typeof kept === 'string') return { type: 'problem', block: 'history', file, line, message: kept };
  return { type: 'history', title, sections: kept, notes: built.notes, ...(more === undefined ? {} : { more }) };
}
