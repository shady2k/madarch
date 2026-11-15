/**
 * The Files page's data shapes (madarch-j9ao.1.1): the files the graph returned,
 * their rhythm, the tree the map drills into, and the table's filters, order and
 * graph-key cursor. The drawing lives in `files-page.tsx`; this module holds the
 * parts a test can read without a browser.
 */
import { byCodePoint } from '../../../../src/model/order.js';

export type FilesArea = 'lines' | 'bytes';
export type FilesColour = 'language' | 'heat' | 'age' | 'authors';
export type FilesWindow = '30d' | '90d' | '1y' | 'all';

export interface FilesPageHeat { readonly d30: number; readonly d90: number; readonly d365: number; readonly all: number }

export interface FilesPageFile {
  readonly id: string;
  readonly node: string;
  readonly href: string;
  readonly repository: string;
  readonly path: string;
  readonly lines: number | null;
  readonly bytes: number | null;
  readonly language: string | null;
  readonly candidates: readonly string[];
  readonly heat: FilesPageHeat;
  readonly lastChange: string | null;
  readonly authorCount: number;
}

export interface FilesPageData { readonly files: readonly FilesPageFile[] }

export interface FolderNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'repository' | 'folder' | 'file';
  readonly repository: string;
  readonly path: string;
  readonly value: number;
  readonly files: number;
  readonly children: readonly FolderNode[];
  readonly language: string | null;
  readonly heat: number;
  readonly age: number | null;
  readonly authors: number;
  readonly href?: string;
  readonly colour?: string;
}

const DAY_MS = 86_400_000;
export const WINDOWS: readonly FilesWindow[] = ['30d', '90d', '1y', 'all'];
export const WINDOW_INDEX: Record<FilesWindow, 0 | 1 | 2 | 3> = { '30d': 0, '90d': 1, '1y': 2, all: 3 };

/** The measure a file's area follows; a missing measure has no area. */
export function areaOf(file: FilesPageFile, area: FilesArea): number {
  const value = area === 'lines' ? file.lines : file.bytes;
  return value === null || value <= 0 ? 0 : value;
}

/** Commits touching a file in the selected window. */
export function heatOf(file: FilesPageFile, window: FilesWindow): number {
  return [file.heat.d30, file.heat.d90, file.heat.d365, file.heat.all][WINDOW_INDEX[window]] ?? 0;
}

/** Days since the last change; null when no commit touched the file. */
export function ageDaysOf(file: FilesPageFile, now: number): number | null {
  if (file.lastChange === null) return null;
  const at = Date.parse(file.lastChange);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / DAY_MS)) : null;
}

/** The value a colour measure gives one file. */
export function measureOf(file: FilesPageFile, colour: FilesColour, window: FilesWindow, now: number): number | null {
  switch (colour) {
    case 'language': return null;
    case 'heat': return heatOf(file, window);
    case 'age': return ageDaysOf(file, now);
    case 'authors': return file.authorCount;
  }
}

/** The totals the sentence above the map states. */
export function totalsOf(files: readonly FilesPageFile[]): { files: number; lines: number; languages: number; bytes: number } {
  const languages = new Set<string>();
  let lines = 0;
  let bytes = 0;
  for (const file of files) {
    if (file.lines !== null) lines += file.lines;
    if (file.bytes !== null) bytes += file.bytes;
    if (file.language !== null) languages.add(file.language);
  }
  return { files: files.length, lines, languages: languages.size, bytes };
}

/** Every language a file states, in code point order, with "Other" for a file no claim names. */
export function languagesOf(files: readonly FilesPageFile[]): string[] {
  const names = new Set<string>();
  for (const file of files) names.add(file.language ?? '');
  return [...names].map((name) => name === '' ? '__other' : name).sort(byCodePoint);
}

/** The categorical token a language takes. The palette is the kit's; the last swatch is "Other". */
export function languageColour(language: string | null, order: readonly string[]): string {
  if (language === null) return 'var(--surface-soft)';
  const at = order.indexOf(language);
  if (at < 0) return 'var(--chart-cat-7)';
  return `var(--chart-cat-${String((at % 6) + 1)})`;
}

/** A ramp step in the kit's heat tokens. `null` (no history) has the quiet surface. */
export function rampColour(value: number | null, max: number): string {
  if (value === null || max <= 0) return 'var(--surface-soft)';
  const ratio = Math.max(0, Math.min(1, value / max));
  const step = ratio === 0 ? 0 : Math.min(4, Math.ceil(ratio * 4));
  return step === 0 ? 'var(--surface-soft)' : `var(--heat-step-${String(step)})`;
}

/** The colour a folder takes: its dominant language or its aggregate measure. */
function folderColour(files: readonly FilesPageFile[], colour: FilesColour, window: FilesWindow, now: number, order: readonly string[]): string {
  if (colour === 'language') {
    const counts = new Map<string, number>();
    for (const file of files) counts.set(file.language ?? '', (counts.get(file.language ?? '') ?? 0) + 1);
    const winner = [...counts.entries()].sort((left, right) => right[1] - left[1] || byCodePoint(left[0], right[0]))[0]?.[0] ?? '';
    return languageColour(winner === '' ? null : winner, order);
  }
  const values = files.map((file) => measureOf(file, colour, window, now)).filter((value): value is number => value !== null);
  const max = Math.max(0, ...values);
  const aggregate = colour === 'heat' ? values.reduce((sum, value) => sum + value, 0) : Math.max(0, ...values);
  return rampColour(aggregate, max);
}

/** The files below one repository/folder scope. */
export function filesInScope(files: readonly FilesPageFile[], scope: { repository: string; path: string } | null): readonly FilesPageFile[] {
  if (scope === null) return files;
  const prefix = scope.path === '' ? '' : `${scope.path}/`;
  return files.filter((file) => file.repository === scope.repository && (prefix === '' || file.path.startsWith(prefix)));
}

/** The files and folders directly inside one scope, for one level of the map. */
export function folderLevel(files: readonly FilesPageFile[], scope: { repository: string; path: string } | null, area: FilesArea): FolderNode[] {
  if (scope === null) {
    const repositories = new Map<string, FilesPageFile[]>();
    for (const file of files) {
      const held = repositories.get(file.repository) ?? [];
      held.push(file);
      repositories.set(file.repository, held);
    }
    return [...repositories.entries()].sort((left, right) => byCodePoint(left[0], right[0])).map(([repository, held]) => folderNode(repository, repository, repository, '', held, area));
  }
  const under = filesInScope(files, scope);
  const prefix = scope.path === '' ? '' : `${scope.path}/`;
  const direct: FilesPageFile[] = [];
  const folders = new Map<string, FilesPageFile[]>();
  for (const file of under) {
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) { direct.push(file); continue; }
    const name = rest.slice(0, slash);
    const path = prefix + name;
    const held = folders.get(path) ?? [];
    held.push(file);
    folders.set(path, held);
  }
  const nodes: FolderNode[] = [];
  for (const [path, held] of [...folders.entries()].sort((left, right) => byCodePoint(left[0], right[0]))) {
    nodes.push(folderNode(`${scope.repository}/${path}`, path.slice(path.lastIndexOf('/') + 1), scope.repository, path, held, area));
  }
  for (const file of direct.sort((left, right) => byCodePoint(left.path, right.path))) {
    nodes.push({
      id: file.id,
      label: file.path.slice(file.path.lastIndexOf('/') + 1),
      kind: 'file',
      repository: file.repository,
      path: file.path,
      value: areaOf(file, area),
      files: 1,
      children: [],
      language: file.language,
      heat: file.heat.all,
      age: ageDaysOf(file, Date.now()),
      authors: file.authorCount,
      href: file.href,
    });
  }
  return nodes;
}

function folderNode(id: string, label: string, repository: string, path: string, files: readonly FilesPageFile[], area: FilesArea): FolderNode {
  const now = Date.now();
  return {
    id,
    label,
    kind: path === '' ? 'repository' : 'folder',
    repository,
    path,
    value: files.reduce((sum, file) => sum + areaOf(file, area), 0),
    files: files.length,
    children: [],
    language: null,
    heat: files.reduce((sum, file) => sum + file.heat.all, 0),
    age: files.reduce<number | null>((oldest, file) => {
      const age = ageDaysOf(file, now);
      return age === null ? oldest : oldest === null ? age : Math.max(oldest, age);
    }, null),
    authors: files.reduce((sum, file) => Math.max(sum, file.authorCount), 0),
  };
}

/** The colour of every node of one map level. */
export function colourNodes(nodes: readonly FolderNode[], files: readonly FilesPageFile[], colour: FilesColour, window: FilesWindow, now: number, order: readonly string[]): FolderNode[] {
  return nodes.map((node) => {
    const held = node.kind === 'file'
      ? files.filter((file) => file.id === node.id)
      : filesInScope(files, { repository: node.repository, path: node.path });
    return { ...node, colour: folderColour(held, colour, window, now, order) };
  });
}

/** One row of the table, with the value the current sort reads. */
export interface FilesTableRow { readonly file: FilesPageFile; readonly value: number | string | null }
export type FilesSort = 'path' | 'repository' | 'language' | 'lines' | 'bytes' | 'heat' | 'age' | 'authors';
export interface FilesTableQuery {
  readonly text: string;
  readonly language: string;
  readonly measure: Exclude<FilesColour, 'language'>;
  readonly window: FilesWindow;
  readonly from: string;
  readonly to: string;
  readonly sort: FilesSort;
  readonly ascending: boolean;
  /** The graph key of the row the page starts after; null at the first page. */
  readonly cursor: string | null;
}

function sortValue(file: FilesPageFile, sort: FilesSort, window: FilesWindow, now: number): number | string | null {
  switch (sort) {
    case 'path': return `${file.repository}/${file.path}`;
    case 'repository': return file.repository;
    case 'language': return file.language ?? '';
    case 'lines': return file.lines;
    case 'bytes': return file.bytes;
    case 'heat': return heatOf(file, window);
    case 'age': return ageDaysOf(file, now);
    case 'authors': return file.authorCount;
  }
}

function compare(left: FilesTableRow, right: FilesTableRow): number {
  if (left.value === null && right.value === null) return 0;
  if (left.value === null) return 1;
  if (right.value === null) return -1;
  if (typeof left.value === 'string' && typeof right.value === 'string') return byCodePoint(left.value, right.value);
  return Number(left.value) - Number(right.value);
}

/** The rows one page of the table holds, filtered, ordered and cut at a graph-key cursor. */
export function tableRows(files: readonly FilesPageFile[], query: FilesTableQuery, now: number, pageSize: number): { rows: FilesTableRow[]; total: number; start: number; more: boolean } {
  const text = query.text.trim().toLowerCase();
  const low = query.from === '' ? null : Number(query.from);
  const high = query.to === '' ? null : Number(query.to);
  const matching = files
    .filter((file) => {
      if (text !== '' && !file.path.toLowerCase().includes(text)) return false;
      if (query.language === '__other' ? file.language !== null : query.language !== '' && query.language !== '__all' && (file.language ?? '') !== query.language) return false;
      if (low !== null || high !== null) {
        const value = measureOf(file, query.measure, query.window, now);
        if (value === null) return false;
        if (low !== null && value < low) return false;
        if (high !== null && value > high) return false;
      }
      return true;
    })
    .map((file): FilesTableRow => ({ file, value: sortValue(file, query.sort, query.window, now) }));
  const ordered = [...matching].sort((left, right) => {
    const order = compare(left, right);
    if (left.value === null || right.value === null) return order;
    return (order || byCodePoint(left.file.id, right.file.id)) * (query.ascending ? 1 : -1);
  });
  const at = query.cursor === null ? -1 : ordered.findIndex((row) => row.file.id === query.cursor);
  const start = at < 0 ? 0 : at + 1;
  return { rows: ordered.slice(start, start + pageSize), total: ordered.length, start, more: start + pageSize < ordered.length };
}
