/** Covered historical reads use indexed ancestry, never raw-date sorting or a page-time Git walk. */
import { byCodePoint } from '../model/order.js';
import type { GraphEntity, HistoryEvidence } from './graph-read.js';
import type { LandmarkCoverage, LandmarkPlan } from './history-landmarks.js';

export interface HistorySelection { repo: string; at: string }
export interface HistoryContext extends HistorySelection {
  coverage: 'covered' | 'unfilled' | 'before' | 'unknown';
  commit: string | null;
  effectiveAt: string | null;
  until: string | null;
  /** All named points, including those whose trees have not been read. */
  points: { name: string; commit: string; covered: boolean }[];
  landmarks?: LandmarkCoverage;
}

/** ISO instants retain microseconds; a date alone means the end of that UTC day. */
export function historyInstant(value: string): string | undefined {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const text = dateOnly ? `${value}T23:59:59.999999Z` : value;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(text);
  if (match === null || match[1] === undefined) return undefined;
  const parsed = new Date(`${match[1]}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== match[1]) return undefined;
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`;
}

/** The complete first-parent chain is required: an incomplete index cannot certify a date. */
export function selectHistory(selection: HistorySelection, evidence: HistoryEvidence, completed: ReadonlySet<number>, landmarks?: LandmarkPlan): HistoryContext {
  const base: HistoryContext = { ...selection, coverage: 'unknown', commit: null, effectiveAt: null, until: null, points: [] };
  const commits = evidence.entities.filter((entity) => entity.kind === 'code.commit' && entity.properties['onFirstParent'] === true);
  const parents = new Map(evidence.edges.filter((edge) => edge.relation === 'code.parent' && edge.properties['position'] === 1).map((edge) => [edge.from, edge.to]));
  const byKey = new Map(commits.map((commit) => [commit.key, commit]));
  const hasChild = new Set([...parents].filter(([key]) => byKey.has(key)).map(([, parent]) => parent));
  const tips = commits.filter((commit) => !hasChild.has(commit.key));
  if (tips.length !== 1) return base;
  const chain: GraphEntity[] = [];
  const seen = new Set<string>();
  for (let current = tips[0]; current !== undefined;) {
    if (seen.has(current.key)) return base;
    seen.add(current.key); chain.unshift(current);
    const parent = parents.get(current.key);
    if (parent !== undefined && !byKey.has(parent)) return base;
    current = parent === undefined ? undefined : byKey.get(parent);
  }
  if (chain.length !== commits.length) return base;
  const snapshots = evidence.entities.filter((entity) => entity.kind === 'code.snapshot');
  if (landmarks !== undefined) {
    const covered = chain.filter((_, index) => completed.has(index + 1));
    base.landmarks = { offered: new Set(Object.values(landmarks.snapshots)).size, covered: covered.length,
      limit: landmarks.limit, overflow: landmarks.omitted > 0, omitted: landmarks.omitted,
      first: covered[0] === undefined ? null : String(covered[0].properties['effectiveAt']),
      last: covered[covered.length - 1] === undefined ? null : String(covered[covered.length - 1]!.properties['effectiveAt']),
      diagnostics: landmarks.diagnostics };
  }
  const namedPoints = new Map(snapshots.map((snapshot) => [snapshot.label, String(snapshot.properties['commit'] ?? '')]));
  for (const [name, commit] of Object.entries(landmarks?.snapshots ?? {})) namedPoints.set(name, commit);
  base.points = [...namedPoints].map(([name, commit]) => ({ name, commit,
    covered: completed.has(chain.findIndex((one) => one.key === `code.commit:${commit}`) + 1) })).sort((a, b) => byCodePoint(a.name, b.name));
  const named = namedPoints.get(selection.at) ?? snapshots.find((snapshot) => snapshot.key === selection.at)?.properties['commit'];
  let selected = named === undefined ? chain.findIndex((one) => one.key === selection.at || one.key === `code.commit:${selection.at}`) : chain.findIndex((one) => one.key === `code.commit:${String(named)}`);
  if (selected < 0 && named === undefined) {
    const instant = historyInstant(selection.at);
    if (instant === undefined) return base;
    for (const [index, one] of chain.entries()) {
      const at = historyInstant(String(one.properties['effectiveAt']));
      if (at === undefined) return base;
      if (at <= instant) selected = index;
    }
    if (selected < 0) return { ...base, coverage: 'before' };
  }
  const commit = chain[selected];
  if (commit === undefined) return base;
  return { ...base, commit: commit.key.slice('code.commit:'.length), effectiveAt: String(commit.properties['effectiveAt']), until: chain[selected + 1] === undefined ? null : String(chain[selected + 1]!.properties['effectiveAt']), coverage: completed.has(selected + 1) ? 'covered' : 'unfilled' };
}

/** The response's in-wiki code links carry the same explicit selection as the page. */
export function withHistoryLinks<T>(value: T, history: HistorySelection): T {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item === null || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, one]) => {
      if (key !== 'href' || typeof one !== 'string' || !/^\/k\/(?:e\/|src(?:\?|$))/.test(one)) return [key, visit(one)];
      const url = new URL(one, 'https://wiki.invalid');
      if (url.pathname.startsWith('/k/e/') && !decodeURIComponent(url.pathname.slice('/k/e/'.length)).startsWith('code.')) return [key, one];
      url.searchParams.set('repo', history.repo); url.searchParams.set('at', history.at);
      return [key, `${url.pathname}${url.search}${url.hash}`];
    }));
  };
  return visit(value) as T;
}
