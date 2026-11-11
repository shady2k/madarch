/**
 * The Files page's read (madarch-j9ao.1): one repository's files with the facts a
 * treemap and a table draw, read from the graph and from nothing else.
 *
 * A file's size is its lines and bytes (the tree lister's facts), its language is
 * the accepted claim beside them, and its rhythm is the history's own: every
 * `touched` edge from a commit to the file, with the commit's date and author.
 * The heat of a file is how many commits touched it in a window, its age is the
 * time since the last of them, and its authors are the distinct signatures that
 * wrote them. Nothing here runs git, reads a checkout or names a file of its own:
 * a repository with no history is a file set with no heat, said as such.
 *
 * The read is bounded by `limit` and never silently: a map that draws fewer files
 * than the graph holds says how many it left out.
 */
import type { RenderContext, Subject } from './blocks.js';
import { entityAddress } from './addresses.js';
import { byCodePoint } from '../model/order.js';

/** The measure the area of a treemap cell follows. */
export type FilesMapArea = 'lines' | 'bytes';
/** The measure the colour of a treemap cell follows. */
export type FilesMapColour = 'language' | 'heat' | 'age' | 'authors';
/** The window a heat count covers; `all` is the whole history the fill read. */
export type FilesMapWindow = '30d' | '90d' | '1y' | 'all';
/** The engines that can draw the map; a block names one of them. */
export type FilesMapEngine = 'echarts' | 'mermaid';

export const FILES_MAP_AREAS: readonly FilesMapArea[] = ['lines', 'bytes'];
export const FILES_MAP_COLOURS: readonly FilesMapColour[] = ['language', 'heat', 'age', 'authors'];
export const FILES_MAP_WINDOWS: readonly FilesMapWindow[] = ['30d', '90d', '1y', 'all'];
export const FILES_MAP_ENGINES: readonly FilesMapEngine[] = ['echarts', 'mermaid'];

/** One open opinion's language and its source: a value is never shown without the opinion that stated it. */
export interface FilesMapLanguageOpinion {
  readonly language: string;
  readonly saidBy: string;
}

/** One file of the map: the facts both the picture and the table show. */
export interface FilesMapFile {
  /** The graph entity's key (`code.file:<repository>/<path>`), which orders the table and its cursors. */
  id: string;
  path: string;
  /** The file's entity page. */
  href: string | null;
  lines: number | null;
  bytes: number | null;
  /** The one language every open opinion names, or null when they name several or none (one is never picked). */
  language: string | null;
  /** Every open opinion's `language` field and the producer that stated it, in code-point order of value then source. */
  languages: readonly FilesMapLanguageOpinion[];
  /** Commits that touched the file: the last 30 days, 90 days, a year, the whole history. */
  heat: readonly [number, number, number, number];
  /** The last change, as the graph states it (ISO 8601 with its offset), or null when no commit touched the file. */
  last: string | null;
  /** The distinct authors of the commits that touched the file, in code-point order. */
  authors: string[];
}

/** One language of the repository, as the totals sentence states it. */
export interface FilesMapLanguage {
  name: string;
  files: number;
  lines: number;
  bytes: number;
}

/** What the whole map holds, for the sentence above it. */
export interface FilesMapTotals {
  files: number;
  /** The lines of the files that hold a count; a binary file has none, and is counted apart. */
  lines: number;
  bytes: number;
  /** Files the graph states are binary, or whose line count it does not hold. */
  withoutLines: number;
  languages: FilesMapLanguage[];
  /** Files with no single language yet (several candidates, none, or the dataset's `unknown`): drawn as Other. */
  other: number;
}

/** The instants the heat windows start at, so a page can say what it counts from. */
export interface FilesMapWindows {
  d30: string;
  d90: string;
  d365: string;
}

export interface FilesMap {
  repository: string;
  /** The folder the map covers, `''` at the repository's root. */
  folder: string;
  files: FilesMapFile[];
  totals: FilesMapTotals;
  windows: FilesMapWindows;
  /** Every file the map's folder holds; null when the read stopped at its limit before it could count them all. */
  graphTotal: number | null;
}

const DAY_MS = 86_400_000;

/** The language dataset's name for a path it cannot name: to a reader it is no language at all. */
const UNKNOWN_LANGUAGE = 'unknown';

/**
 * The repository a subject belongs to and the folder the map covers: a repository
 * page covers the whole tree, a directory page its folder, and any other entity
 * the graph places in a repository the folder its own place stands in (a service
 * page's map is the files it holds, as it was before the Files page).
 */
export function scopeOf(subject: Subject): { repository: string; folder: string; scope: string } | undefined {
  if (subject.source !== 'graph') return undefined;
  const { kind, properties } = subject.entity;
  if (kind === 'code.repository') {
    const repository = typeof properties['name'] === 'string' ? properties['name'] : subject.entity.label;
    return { repository, folder: '', scope: subject.entity.scope };
  }
  if (typeof properties['repository'] !== 'string' || properties['repository'] === '') return undefined;
  const repository = properties['repository'];
  if (kind === 'code.directory') return { repository, folder: String(properties['path'] ?? ''), scope: subject.entity.scope };
  const path = subject.entity.span?.path;
  if (path === undefined) return undefined;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return { repository, folder, scope: subject.entity.scope };
}

/**
 * One repository's files below one folder, with their history facts. The scope is
 * the repository's node: the history evidence of it holds every file, every
 * commit and every signature of the repository, and its touched edges join them.
 */
const readMaps = new WeakMap<RenderContext, Map<string, Promise<FilesMap>>>();

/**
 * The read of one map, kept for the page that asks: a template that places both the map and the table reads the file
 * set and its rhythm once, not once per block. The cache lives as long as the page's own read context does.
 */
export async function readFilesMap(
  ctx: RenderContext,
  subject: Subject,
  options: { readonly folder?: string; readonly limit: number; readonly now?: Date },
): Promise<FilesMap> {
  const scope = scopeOf(subject);
  const folder = (options.folder ?? scope?.folder ?? '').replace(/^\/+|\/+$/g, '');
  const key = `${scope?.repository ?? ''}|${folder}|${String(options.limit)}`;
  const held = readMaps.get(ctx) ?? new Map<string, Promise<FilesMap>>();
  const known = held.get(key);
  if (known !== undefined) return await known;
  const reading = readFilesMapUncached(ctx, subject, options);
  held.set(key, reading);
  readMaps.set(ctx, held);
  return await reading;
}

async function readFilesMapUncached(
  ctx: RenderContext,
  subject: Subject,
  options: { readonly folder?: string; readonly limit: number; readonly now?: Date },
): Promise<FilesMap> {
  const scope = scopeOf(subject);
  if (scope === undefined) throw new Error('the files map reads a code.repository or a code.directory page');
  const folder = (options.folder ?? scope.folder).replace(/^\/+|\/+$/g, '');
  const now = (options.now ?? new Date()).getTime();
  // One repository's files, read by its own pages: a page of the map may not walk every file of every repository the
  // product holds. The read stops at the block's limit, and the map says what it left out (its page knows the
  // repository's count; a folder's count is known only when its last page was read).
  const inside: { path: string; lines: number | null; bytes: number | null; language: string | null; languages: FilesMapLanguageOpinion[] }[] = [];
  let after: string | undefined;
  let exhausted = false;
  for (;;) {
    const page = await ctx.graph.files(scope.repository, {
      ...(folder === '' ? {} : { prefix: `${folder}/` }),
      ...(after === undefined ? {} : { after }),
      limit: Math.max(1, options.limit - inside.length),
    });
    for (const row of page.rows) {
      if (inside.length >= options.limit) break;
      // A file's programming language is the opinion's field `language` (madarch-64o5.2; never `lang`, which names the
      // natural language of a text): every open opinion that states one stands with its source (decision 0034 item 7;
      // A4), and no producer is filtered out or preferred over another.
      const opinions = (row.opinions ?? []).flatMap((opinion) => {
        const value = opinion.values['language'];
        return typeof value === 'string' ? [{ language: value, saidBy: opinion.saidBy }] : [];
      });
      inside.push({ path: row.path, lines: row.lines, bytes: row.bytes, language: row.language, languages: opinions });
    }
    if (page.next === null) { exhausted = true; break; }
    if (inside.length >= options.limit) break;
    after = page.next;
  }
  const graphTotal = folder === ''
    ? (await ctx.graph.repository(scope.repository))?.counts.files ?? inside.length
    : exhausted ? inside.length : null;
  // The rhythm of every file in one bounded read: its commits per window, its newest change and its authors. The whole
  // history evidence (every commit, every edge) is what the history blocks read, and a page that draws a map of
  // thousands of files may not carry it.
  const windows: FilesMapWindows = {
    d30: new Date(now - 30 * DAY_MS).toISOString(),
    d90: new Date(now - 90 * DAY_MS).toISOString(),
    d365: new Date(now - 365 * DAY_MS).toISOString(),
  };
  const rhythm = await ctx.graph.fileRhythm(scope.repository, windows);
  const languages = new Map<string, FilesMapLanguage>();
  let withoutLines = 0;
  let other = 0;
  let lines = 0;
  let bytes = 0;
  const files: FilesMapFile[] = inside.map((file) => {
    const path = file.path;
    const languageOpinions = [...file.languages].sort((left, right) => byCodePoint(left.language, right.language) || byCodePoint(left.saidBy, right.saidBy));
    // The language a file is drawn by is the one its open opinions accept, computed by the read that holds them: the
    // page never picks one. Where they name several, or the dataset's `unknown`, the value is null: the file is drawn
    // as Other and every value it does state stands with its source.
    const drawn = file.language === UNKNOWN_LANGUAGE ? null : file.language;
    const fileLines = file.lines;
    const fileBytes = file.bytes;
    if (fileLines === null) withoutLines += 1;
    else lines += fileLines;
    if (fileBytes !== null) bytes += fileBytes;
    if (drawn === null) other += 1;
    else {
      const held = languages.get(drawn) ?? { name: drawn, files: 0, lines: 0, bytes: 0 };
      held.files += 1;
      held.lines += fileLines ?? 0;
      held.bytes += fileBytes ?? 0;
      languages.set(drawn, held);
    }
    const held = rhythm.get(path);
    const heat: [number, number, number, number] = held === undefined ? [0, 0, 0, 0] : [held.d30, held.d90, held.d365, held.all];
    const authors = held?.authors ?? [];
    const last = held?.last ?? null;
    return {
      id: `code.file:${scope.repository}/${path}`,
      path,
      href: entityAddress(`code.file:${scope.repository}/${path}`),
      lines: fileLines,
      bytes: fileBytes,
      language: drawn,
      languages: languageOpinions,
      heat,
      last: last === null ? null : new Date(last).toISOString(),
      authors: [...authors].sort(byCodePoint),
    };
  });
  files.sort((left, right) => byCodePoint(left.id, right.id));
  return {
    repository: scope.repository,
    folder,
    files,
    totals: { files: inside.length, lines, bytes, withoutLines, other, languages: [...languages.values()].sort((left, right) => right.files - left.files || byCodePoint(left.name, right.name)) },
    windows,
    graphTotal,
  };
}
