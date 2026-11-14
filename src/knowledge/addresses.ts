/**
 * The addresses of the knowledge wiki's routes (decision 0029, amended by
 * madarch-q6mx: the owner asked that the `/k` segment go — it once separated the
 * knowledge wiki from the documents app, which is gone, and it names nothing
 * now). One module builds every address, so a route is spelled in one place:
 * the reader's pages, the page files, the API and the links written into
 * Markdown or JSON all read from here.
 */

/**
 * A name in an address: a terminal `.md` or `.json` would be read as the file's
 * suffix, so that one dot is encoded and an entity whose id ends in it keeps an
 * HTML address of its own.
 */
export function addressName(name: string): string {
  // Parentheses are sub-delimiters `encodeURIComponent` keeps, and an unbalanced
  // one would end a Markdown destination early; written as escapes they cannot.
  const encoded = encodeURIComponent(name).replaceAll('(', '%28').replaceAll(')', '%29');
  for (const suffix of ['.md', '.json']) {
    if (encoded.endsWith(suffix)) return `${encoded.slice(0, -suffix.length)}%2E${suffix.slice(1)}`;
  }
  return encoded;
}

/** The reader's pages that stand at one address. */
export const HOME_ADDRESS = '/';
export const SETTINGS_ADDRESS = '/settings';

/**
 * One entity, addressed by its key (`code.file:<repository>/<path>`): the form the data an agent reads names an entity in,
 * and the identifier a statement's ground or a problem's place carries. A person's page of an entity is addressed by its
 * kind and its id (decision 0036, section 7), which only the graph answers; an app that opens a key-addressed link says
 * the address names no page.
 */
export const entityAddress = (key: string): string => `${ENTITY_ADDRESS_BASE}${addressName(key)}`;
export function sourceAddress(repo: string | null, path: string, line?: number): string {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  if (line !== undefined) query.set('line', String(line));
  return `/src?${query.toString()}`;
}

/** Where a Markdown document stands in the app: a page of its own, at the section an anchor names. */
export function documentAddress(repo: string | null, path: string, anchor?: string | null): string {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  return `/doc?${query.toString()}${anchor === undefined || anchor === null || anchor === '' ? '' : `#${encodeURIComponent(anchor)}`}`;
}

/** Where a question of the loop stands. */
export const questionAddress = (slug: string): string => `/questions/${encodeURIComponent(slug)}`;

/** The app's two address families (decision 0036, section 7): an entity's page, and a template bound to no entity. */
export const ENTITY_ADDRESS_BASE = '/e/';
export const TEMPLATE_ADDRESS_BASE = '/p/';

/** The app's two address families, matched by prefix: `/e/kind/id` and `/p/template`. */
const WIKI_PAGE_FAMILIES: readonly string[] = [ENTITY_ADDRESS_BASE, TEMPLATE_ADDRESS_BASE];

/** Every path the app answers, for a refusal that names them. */
export function wikiPageAddresses(): string[] {
  return [HOME_ADDRESS, ...WIKI_PAGE_FAMILIES];
}

/** Whether the app answers this path itself, rather than the server naming it unknown. */
export function isWikiPagePath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return path === HOME_ADDRESS || WIKI_PAGE_FAMILIES.some((family) => pathname.startsWith(family) && pathname.slice(family.length).length > 0);
}

/** The API the wiki answers, one address per answer. */
export const API = {
  product: '/api/product',
  status: '/api/status',
  catalog: '/api/catalog',
  search: '/api/search',
  page: '/api/page',
  block: '/api/block',
  statement: '/api/statement',
  facts: '/api/facts',
  entities: '/api/entities',
  kindUsage: '/api/kind-usage',
  authored: '/api/authored',
  authoredSchema: '/api/authored-schema',
  neighborhood: '/api/neighborhood',
  view: '/api/view',
  viewFrame: '/api/view-frame',
  source: '/api/source',
  run: '/api/run',
  products: '/api/products',
  fill: '/api/fill',
  fillSelected: '/api/fill-selected',
  fillRuns: '/api/fill-runs',
  pause: '/api/pause',
  stop: '/api/stop',
  agents: '/api/agents',
  agent: '/api/agent',
  documents: '/api/documents',
  document: '/api/document',
  glossary: '/api/glossary',
  settings: '/api/settings',
  questions: '/api/questions',
  question: '/api/question',
  answer: '/api/answer',
  correction: '/api/correction',
  problems: '/api/problems',
  problemDismiss: '/api/problem-dismiss',
  problemTask: '/api/problem-task',
  journal: '/api/journal',
  refreshPlan: '/api/refresh-plan',
  tasks: '/api/tasks',
  task: '/api/task',
  taskPropose: '/api/task-propose',
  taskImpact: '/api/task-impact',
  taskCreate: '/api/task-create',
  taskClose: '/api/task-close',
  taskRun: '/api/task-run',
  reset: '/api/reset',
  productSettings: '/api/product-settings',
  agentChoices: '/api/agent-choices',
  modelRole: '/api/model-role',
  graphVerdicts: '/api/graph-verdicts',
  rewritePages: '/api/rewrite-pages',
  startFresh: '/api/start-fresh',
} as const;
