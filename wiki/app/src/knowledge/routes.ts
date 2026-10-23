import { appRoute } from '../app-base.js';

/** The knowledge wiki's routes, under `/k` (decision 0029). */
export type KRoute =
  | { name: 'home' }
  | { name: 'entity'; id: string }
  | { name: 'kind'; kind: string }
  | { name: 'source'; repo: string | null; path: string; line: number | null }
  | { name: 'docs' }
  | { name: 'doc'; repo: string | null; path: string }
  | { name: 'catalogue' }
  | { name: 'statement'; id: string; sentence: string; turn: number };

export const K_HOME = '/k';
export const K_DOCS = '/k/docs';
export const K_CATALOGUE = '/k/catalogue';
/** Where the statement view of a sentence of a page stands. */
export function addressOfStatement(id: string, sentence: string, turn = 0): string {
  return `/k/statement?${new URLSearchParams({ id, sentence, ...(turn > 0 ? { n: String(turn) } : {}) }).toString()}`;
}
/** Where a Markdown document stands, at a section when an anchor is given. */
export function addressOfDocument(repo: string | null, path: string, anchor?: string): string {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  return `/k/doc?${query.toString()}${anchor === undefined || anchor === '' ? '' : `#${encodeURIComponent(anchor)}`}`;
}
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
  if (path === '/k/docs') return { name: 'docs' };
  if (path === '/k/catalogue') return { name: 'catalogue' };
  if (path === '/k/statement') {
    const query = new URLSearchParams(search);
    const id = query.get('id');
    const sentence = query.get('sentence');
    if (id === null || id === '' || sentence === null || sentence === '') return { name: 'home' };
    const turn = Number(query.get('n') ?? 0);
    return { name: 'statement', id, sentence, turn: Number.isInteger(turn) && turn > 0 ? turn : 0 };
  }
  if (path === '/k/doc') {
    const query = new URLSearchParams(search);
    const file = query.get('path');
    if (file === null || file === '') return { name: 'docs' };
    return { name: 'doc', repo: query.get('repo'), path: file };
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
