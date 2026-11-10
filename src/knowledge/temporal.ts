/** Covered historical reads use indexed ancestry, never raw-date sorting or a page-time Git walk. */
import type { LandmarkCoverage } from './history-landmarks.js';

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
