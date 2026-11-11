/**
 * The file page's one block (madarch-j9ao.2.1): the file's facts, its text, the commits that touched it and the files
 * changed with it. Everything is read from the graph — the files producer's facts and bytes, the touched and commit
 * edges, the history evidence — and nothing reads Git or the file system at page time. The app draws the header, the
 * Overview's Rendered/Source switch and the History and Co-change tabs.
 */
import { sourceAddress } from './addresses.js';
import { languageOf, refOfGraph, type RenderContext, type Subject } from './blocks.js';
import type { GraphEntity, HistoryEvidence } from './graph-read.js';
import { projectHistory } from './history-evidence.js';
import type { Block, FileCochangeEntry, FileHistoryEntry } from './model.js';

/** One commit's hash from the graph's commit entities. */
function hashOf(commit: GraphEntity | undefined, fallback: string): string {
  const hash = commit?.properties['hash'];
  return typeof hash === 'string' && hash !== '' ? hash : fallback;
}

/** The graph's history of one file, shaped into the page's History and Co-change tabs. */
async function tabsOf(ctx: RenderContext, subject: Subject, evidence: HistoryEvidence, repository: string): Promise<{ history: FileHistoryEntry[]; cochange: FileCochangeEntry[]; cochangeTotal: number; commits: number }> {
  if (subject.source !== 'graph') return { history: [], cochange: [], cochangeTotal: 0, commits: 0 };
  const commits = new Map(evidence.entities.filter((entity) => entity.kind === 'code.commit').map((entity) => [entity.key, entity] as const));
  const projection = projectHistory(evidence, subject.entity, 'path', 100_000, (entity) => refOfGraph(ctx, entity));
  const commitSection = projection.sections.find((section) => section.role === 'commits');
  const history: FileHistoryEntry[] = [];
  for (const row of commitSection?.rows ?? []) {
    const id = row.entity?.id ?? '';
    const commit = commits.get(id);
    const hash = hashOf(commit, id.slice(id.indexOf(':') + 1));
    const figure = (kind: string): number | null => {
      const held = row.figures.find((one) => one.kind === kind);
      return held === undefined ? null : Number(held.value);
    };
    const change = row.figures.find((one) => one.kind === 'change')?.value;
    // The history evidence's commit may carry only its key; the commit page's facts then name its subject and dates.
    const facts = typeof commit?.properties['subject'] === 'string' ? undefined : await ctx.graph.commit(repository, hash);
    const stamp = row.when !== undefined && row.when !== '' && !row.when.startsWith('undefined')
      ? row.when
      : String(facts?.commitDate ?? facts?.authorDate ?? commit?.properties['committedAt'] ?? commit?.properties['authorDate'] ?? '');
    history.push({
      hash,
      href: row.entity?.href ?? null,
      when: stamp.slice(0, 10),
      ...(row.who === undefined ? {} : { who: row.who }),
      subject: typeof commit?.properties['subject'] === 'string' ? commit.properties['subject'] : facts?.subject ?? row.text,
      added: figure('added'),
      removed: figure('removed'),
      change: change === 'added' || change === 'modified' || change === 'deleted' || change === 'renamed' ? change : null,
    });
  }
  const coupling = projection.sections.find((section) => section.role === 'coupling');
  const cochange: FileCochangeEntry[] = (coupling?.rows ?? []).slice(0, 5).map((row) => {
    const both = Number(row.figures.find((one) => one.kind === 'both')?.value ?? '0');
    return {
      path: row.text,
      href: row.entity?.href ?? null,
      both,
      share: history.length === 0 ? 0 : both / history.length,
    };
  });
  return { history, cochange, cochangeTotal: coupling?.total ?? cochange.length, commits: history.length };
}

export async function filePageBlock(ctx: RenderContext, subject: Subject, file: string, line: number): Promise<Block> {
  if (subject.source !== 'graph' || subject.entity.kind !== 'code.file') {
    return { type: 'problem', block: 'file-page', file, line, message: 'the file page shows a code.file entity' };
  }
  const repository = String(subject.entity.properties['repository'] ?? '');
  const path = String(subject.entity.properties['path'] ?? '');
  const data = await ctx.graph.file(repository, path);
  if (data === null) return { type: 'problem', block: 'file-page', file, line, message: `the graph holds no file ${JSON.stringify(path)} of ${repository}` };
  const repo = ctx.repoOfScope(subject.entity.scope) ?? repository;
  const text = await ctx.readSource(repo, path);
  const source = text === undefined ? undefined : {
    text,
    language: languageOf(path),
    href: sourceAddress(repo, path, 1),
    ...(ctx.webOf?.(repo, path, 1, text.split('\n').length) === undefined ? {} : { web: ctx.webOf!(repo, path, 1, text.split('\n').length)! }),
  };
  const evidence = await ctx.graph.historyEvidenceFor(subject.entity, 'path', 5);
  const tabs = await tabsOf(ctx, subject, evidence, repository);
  return {
    type: 'filePage',
    data,
    ...(source === undefined ? {} : { source }),
    markdown: /\.(md|markdown)$/iu.test(path),
    ...tabs,
  };
}
