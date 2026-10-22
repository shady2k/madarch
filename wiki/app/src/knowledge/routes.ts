import { appRoute } from '../app-base.js';

/** The knowledge wiki's routes, under `/k` (decision 0029). */
export type KRoute =
  | { name: 'home' }
  | { name: 'entity'; id: string }
  | { name: 'kind'; kind: string }
  | { name: 'source'; repo: string | null; path: string; line: number | null };

export const K_HOME = '/k';
export const addressOfEntity = (id: string): string => `/k/e/${encodeURIComponent(id)}`;
export const addressOfKind = (kind: string): string => `/k/kind/${encodeURIComponent(kind)}`;

/** The route an address is, or null when the address is not under `/k`. */
export function kRouteOf(pathname: string, search = ''): KRoute | null {
  const path = appRoute(pathname);
  if (path === '/k' || path === '/k/') return { name: 'home' };
  if (path.startsWith('/k/e/')) {
    try {
      return { name: 'entity', id: decodeURIComponent(path.slice('/k/e/'.length)) };
    } catch {
      return { name: 'home' };
    }
  }
  if (path.startsWith('/k/kind/')) {
    try {
      return { name: 'kind', kind: decodeURIComponent(path.slice('/k/kind/'.length)) };
    } catch {
      return { name: 'home' };
    }
  }
  if (path === '/k/src') {
    const query = new URLSearchParams(search);
    const file = query.get('path');
    if (file === null || file === '') return { name: 'home' };
    const line = Number(query.get('line'));
    return { name: 'source', repo: query.get('repo'), path: file, line: Number.isInteger(line) && line > 0 ? line : null };
  }
  return null;
}

/** The kind's word for a reader: the extractor prefix dropped, the first letter up. */
export function kindWord(kind: string): string {
  const bare = kind.startsWith('code.') ? kind.slice('code.'.length) : kind;
  const spaced = bare.replace(/[-_.]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The plural of a kind's word, for a group heading. */
export function kindPlural(kind: string): string {
  const word = kindWord(kind);
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}
