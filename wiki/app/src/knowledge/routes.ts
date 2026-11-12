import { appRoute } from '../app-base.js';

/** The knowledge wiki's routes, at the root (decision 0029, amended by madarch-q6mx: no `/k` segment). */
export type WikiRoute =
  | { name: 'home' }
  | { name: 'authored'; kind: string; uid: string }
  | { name: 'kit' }
  | { name: 'entity'; id: string; after: string | null }
  | { name: 'kind'; kind: string }
  | { name: 'source'; repo: string | null; path: string; line: number | null }
  | { name: 'run'; run: string | null }
  | { name: 'docs' }
  | { name: 'doc'; repo: string | null; path: string }
  | { name: 'catalogue' }
  | { name: 'glossary' }
  | { name: 'problems' }
  | { name: 'settings' }
  | { name: 'journal'; id: string; run: string | null }
  | { name: 'fill' }
  | { name: 'statement'; id: string; sentence: string; turn: number };

export const WIKI_KIT = '/kit';
export const WIKI_HOME = '/';
export const WIKI_DOCS = '/docs';
export const WIKI_CATALOGUE = '/catalogue';
export const WIKI_GLOSSARY = '/glossary';
export const WIKI_QUESTIONS = '/kind/question';
export const WIKI_PROBLEMS = '/problems';
export const WIKI_SETTINGS = '/settings';
/** Where the journal of the agent's work on a page stands (madarch-m38l.13). */
export function addressOfJournal(id: string, run?: string): string {
  return `/journal?${new URLSearchParams({ id, ...(run === undefined ? {} : { run }) }).toString()}`;
}
/** Where the fill stands, page by page, while it writes and after it ends (madarch-m38l.23). */
export const WIKI_FILL = '/fill';
export const WIKI_TASKS = '/kind/task';
/** The newest run's trace, step by step: its wall clock, its memory and its slowest names (madarch-8bdc.2.5, item 4). */
export const WIKI_RUN = '/run';

/** Where the statement view of a sentence of a page stands. */
export function addressOfStatement(id: string, sentence: string, turn = 0): string {
  return `/statement?${new URLSearchParams({ id, sentence, ...(turn > 0 ? { n: String(turn) } : {}) }).toString()}`;
}
/** Where a Markdown document stands, at a section when an anchor is given. */
export function addressOfDocument(repo: string | null, path: string, anchor?: string): string {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  return `/doc?${query.toString()}${anchor === undefined || anchor === '' ? '' : `#${encodeURIComponent(anchor)}`}`;
}

/**
 * A name in an address: a terminal `.md` or `.json` would be read as the file's
 * suffix, so that one dot is encoded and an entity whose id ends in it keeps an
 * HTML address of its own (the engine's `addresses.ts` says the same).
 */
function addressName(name: string): string {
  const encoded = encodeURIComponent(name).replaceAll('(', '%28').replaceAll(')', '%29');
  for (const suffix of ['.md', '.json']) {
    if (encoded.endsWith(suffix)) return `${encoded.slice(0, -suffix.length)}%2E${suffix.slice(1)}`;
  }
  return encoded;
}

export const ENTITY_ADDRESS_PREFIX = '/e/';
export const addressOfEntity = (id: string): string => `/e/${addressName(id)}`;
export const addressOfKind = (kind: string): string => `/kind/${addressName(kind)}`;

/** The API the app reads: one address per answer. */
export const API = {
  product: '/api/product',
  status: '/api/status',
  catalog: '/api/catalog',
  search: '/api/search',
  page: '/api/page',
  block: '/api/block',
  statement: '/api/statement',
  entities: '/api/entities',
  kindUsage: '/api/kind-usage',
  neighborhood: '/api/neighborhood',
  view: '/api/view',
  viewFrame: '/api/view-frame',
  source: '/api/source',
  run: '/api/run',
  products: '/api/products',
  fill: '/api/fill',
  fillSelected: '/api/fill-selected',
  pause: '/api/pause',
  stop: '/api/stop',
  agents: '/api/agents',
  agent: '/api/agent',
  documents: '/api/documents',
  document: '/api/document',
  glossary: '/api/glossary',
  settings: '/api/settings',
  problems: '/api/problems',
  problemDismiss: '/api/problem-dismiss',
  journal: '/api/journal',
  refreshPlan: '/api/refresh-plan',
  reset: '/api/reset',
  productSettings: '/api/product-settings',
  agentChoices: '/api/agent-choices',
  modelRole: '/api/model-role',
  graphVerdicts: '/api/graph-verdicts',
  rewritePages: '/api/rewrite-pages',
  startFresh: '/api/start-fresh',
} as const;

/** The route an address is, or null when the app answers no such path. */
export function wikiRouteOf(pathname: string, search = ''): WikiRoute | null {
  const path = appRoute(pathname);
  if (path === WIKI_KIT || path === `${WIKI_KIT}/`) return { name: 'kit' };
  if (path === '/' || path === '') return { name: 'home' };
  if (path === '/authored') {
    const query = new URLSearchParams(search);
    const kind = query.get('kind');
    const uid = query.get('uid');
    return kind && uid ? { name: 'authored', kind, uid } : { name: 'home' };
  }
  if (path === '/problems' || path === '/problems/') return { name: 'problems' };
  if (path === '/settings' || path === '/settings/') return { name: 'settings' };
  if (path === '/fill' || path === '/fill/') return { name: 'fill' };
  if (path === '/journal') {
    const query = new URLSearchParams(search);
    const id = query.get('id');
    return id === null || id === '' ? { name: 'home' } : { name: 'journal', id, run: query.get('run') };
  }
  if (path.startsWith('/e/')) {
    try {
      const id = decodeURIComponent(path.slice('/e/'.length));
      const query = new URLSearchParams(search);
      const after = query.get('after');
      return { name: 'entity', id, after: after === null || after === '' ? null : after };
    } catch {
      return { name: 'home' };
    }
  }
  if (path.startsWith('/kind/')) {
    try {
      return { name: 'kind', kind: decodeURIComponent(path.slice('/kind/'.length)) };
    } catch {
      return { name: 'home' };
    }
  }
  if (path === '/docs') return { name: 'docs' };
  if (path === '/catalogue') return { name: 'catalogue' };
  if (path === '/glossary') return { name: 'glossary' };
  if (path === '/statement') {
    const query = new URLSearchParams(search);
    const id = query.get('id');
    const sentence = query.get('sentence');
    if (id === null || id === '' || sentence === null || sentence === '') return { name: 'home' };
    const turn = Number(query.get('n') ?? 0);
    return { name: 'statement', id, sentence, turn: Number.isInteger(turn) && turn > 0 ? turn : 0 };
  }
  if (path === '/doc') {
    const query = new URLSearchParams(search);
    const file = query.get('path');
    if (file === null || file === '') return { name: 'docs' };
    return { name: 'doc', repo: query.get('repo'), path: file };
  }
  if (path === '/run') {
    const query = new URLSearchParams(search);
    return { name: 'run', run: query.get('run') };
  }
  if (path === '/src') {
    const query = new URLSearchParams(search);
    const file = query.get('path');
    if (file === null || file === '') return { name: 'home' };
    const line = Number(query.get('line'));
    return { name: 'source', repo: query.get('repo'), path: file, line: Number.isInteger(line) && line > 0 ? line : null };
  }
  return null;
}

/** Whether a link names a page of this app, so it opens in the wiki rather than as a plain link. */
export function isWikiAddress(href: string): boolean {
  const pathname = href.split(/[?#]/, 1)[0] ?? '';
  return wikiRouteOf(pathname) !== null;
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