/** Product-owned scoped tasks proposed from answers (madarch-m38l.14). */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { taskId } from './ids.js';
import type { Author } from './entities.js';

export const TASKS_FOLDER = 'docs/tasks';
/**
 * What a task changes: a section of a document, a range of its lines, a code
 * symbol, a statement of a page, or a whole path — the whole path only when
 * the task says so itself, never as a widening of a narrower scope.
 */
export type TaskScope =
  | { type: 'section'; path: string; anchor: string }
  | { type: 'lines'; path: string; start: number; end: number }
  | { type: 'symbol'; key: string }
  | { type: 'statement'; key: string }
  | { type: 'file'; path: string };
export interface PlannedTask { slug: string; id: string; file: string; title: string; status: 'open' | 'closed'; question: string; answer: string; /** The problem this task was opened from (madarch-m38l.19); empty for a task made from a question's answer. */ problem?: string; grounds: string[]; scope: TaskScope[]; by: Author; at: string; closedBy: string | null; closedAt: string | null; }
export interface TaskFinding { file: string; line: number; message: string; }

/**
 * A place a task changes, as a reader says it (madarch-m38l.14, the owner's review): a section's heading and its
 * document's title, a document's title, a symbol's or a statement's words — each with the address that opens it. The
 * path stays as small secondary text, and the stored words only as a fallback: a reader is never shown a `doc:` key.
 */
export interface PlaceView {
  readonly kind: 'section' | 'file' | 'lines' | 'symbol' | 'statement';
  /** The place's own name: a section's heading, a document's title, a symbol's or a statement's words. */
  readonly label: string;
  /** Where it stands: the document's title of a section, the file of a symbol; null when the label says it. */
  readonly where: string | null;
  readonly href: string | null;
  /** The path, as small secondary text. */
  readonly path: string | null;
  /** The stored scope as words, for a tooltip and for a client that knows no better. */
  readonly words: string;
}

/** The path a scope names, when it names one: what a commit touches and a document page marks. */
export function scopePath(scope: TaskScope): string | undefined {
  switch (scope.type) {
    case 'section': return scope.path;
    case 'lines': return scope.path;
    case 'file': return scope.path;
    // A symbol's key is `code.symbol:<path>#<name>`: the path is what a commit changes, the prefix is not.
    case 'symbol': {
      const key = scope.key.startsWith('code.symbol:') ? scope.key.slice('code.symbol:'.length) : scope.key;
      const hash = key.indexOf('#');
      return hash < 0 ? key : key.slice(0, hash);
    }
    // A statement stands on a page of the product, and its file is that page's: the caller resolves it (closingCommit).
    case 'statement': return undefined;
  }
}

/** A scope as a reader says it: `README.md#what-it-does`, `src/a.ts:12-20`, a code symbol's graph key, a statement's, or a path. */
export function scopeWords(scope: TaskScope): string {
  switch (scope.type) {
    case 'section': return `${scope.path}#${scope.anchor}`;
    case 'lines': return `${scope.path}:${scope.start}-${scope.end}`;
    case 'file': return scope.path;
    case 'symbol': return scope.key.startsWith('code.symbol:') ? scope.key : `code.symbol:${scope.key}`;
    case 'statement': return scope.key;
  }
}

export function renderTask(task: Omit<PlannedTask, 'id' | 'file'>): string {
  const front = {
    id: `task:${task.slug}`, kind: 'task', title: task.title, status: task.status, question: task.question, answer: task.answer,
    ...(task.problem === undefined || task.problem === '' ? {} : { problem: task.problem }),
    grounds: [...task.grounds], scope: task.scope.map((scope) => ({ ...scope })), producer: 'person', 'created-by': { ...task.by }, 'created-at': task.at,
    ...(task.closedBy === null ? {} : { 'closed-by': task.closedBy, 'closed-at': task.closedAt ?? task.at }),
  };
  const yaml = stringifyYaml(front, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n## Task\n\n${task.title}\n`;
}

/** A scope as a reader or a client sent it, when it is one; undefined when it is not (the caller says why). */
export function readScope(value: unknown): TaskScope | undefined {
  try {
    return parseScope('docs/tasks:1', value, 0);
  } catch {
    return undefined;
  }
}

function parseScope(file: string, value: unknown, ix: number): TaskScope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}:2: scope[${ix}] is a mapping`);
  const s = value as Record<string, unknown>;
  if (s['type'] === 'section' && typeof s['path'] === 'string' && typeof s['anchor'] === 'string') return { type: 'section', path: s['path'], anchor: s['anchor'].toLowerCase() };
  if (s['type'] === 'lines' && typeof s['path'] === 'string' && Number.isInteger(s['start']) && Number.isInteger(s['end']) && (s['start'] as number) > 0 && (s['end'] as number) >= (s['start'] as number)) return { type: 'lines', path: s['path'], start: s['start'] as number, end: s['end'] as number };
  if (s['type'] === 'file' && typeof s['path'] === 'string' && s['path'] !== '') return { type: 'file', path: s['path'] };
  if ((s['type'] === 'symbol' || s['type'] === 'statement') && typeof s['key'] === 'string' && s['key'] !== '') return { type: s['type'], key: s['key'] };
  throw new Error(`${file}:2: scope[${ix}] is a section { path, anchor }, lines { path, start, end }, file { path }, symbol or statement { key }`);
}

export function parseTask(file: string, source: string): PlannedTask {
  const { front } = splitFrontMatter(source.replace(/\r\n/g, '\n'));
  if (front === null) throw new Error(`${file}:1: the task has no front matter`);
  let raw: unknown; try { raw = parseYaml(front); } catch (e) { throw new Error(`${file}:2: task front matter is not YAML: ${(e as Error).message.split('\n')[0]}`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}:2: task front matter is a mapping`);
  const r = raw as Record<string, unknown>; const slug = file.slice(file.lastIndexOf('/') + 1, -3);
  const text = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '');
  if (r['id'] !== `task:${slug}` || r['kind'] !== 'task') throw new Error(`${file}:2: task id and kind must name task:${slug}`);
  if (r['status'] !== 'open' && r['status'] !== 'closed') throw new Error(`${file}:2: task status is open or closed`);
  const grounds = r['grounds']; if (!Array.isArray(grounds) || grounds.some((x) => typeof x !== 'string' || x === '')) throw new Error(`${file}:2: task grounds are a list of non-empty keys`);
  const scope = r['scope']; if (!Array.isArray(scope) || scope.length === 0) throw new Error(`${file}:2: task scope is a non-empty list`);
  const parsed = scope.map((value, ix) => parseScope(file, value, ix));
  const by = r['created-by']; if (by === null || typeof by !== 'object' || typeof (by as Record<string, unknown>)['name'] !== 'string' || typeof (by as Record<string, unknown>)['email'] !== 'string') throw new Error(`${file}:2: created-by names the person`);
  const closedBy = r['closed-by'];
  if (closedBy !== undefined && (typeof closedBy !== 'string' || closedBy === '')) throw new Error(`${file}:2: closed-by is "person" or the commit that closed the task, or absent`);
  // A file that says closed and names no commit was closed by hand: the status is kept, and the closure says how.
  const how: string | null = typeof closedBy === 'string' ? closedBy : r['status'] === 'closed' ? 'person' : null;
  return { slug, id: `task:${slug}`, file, title: text('title'), status: r['status'], question: text('question'), answer: text('answer'), ...(text('problem') === '' ? {} : { problem: text('problem') }), grounds: grounds as string[], scope: parsed, by: by as Author, at: text('created-at'), closedBy: how, closedAt: text('closed-at') || null };
}

export function readTasks(folder: string): { tasks: PlannedTask[]; findings: TaskFinding[] } {
  let files: string[];
  try { files = readdirSync(join(folder, TASKS_FOLDER)).filter((f) => f.endsWith('.md')).sort(byCodePoint); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], findings: [] }; throw new Error(`${TASKS_FOLDER}:1: cannot list task files: ${(e as Error).message}`); }
  const tasks: PlannedTask[] = [], findings: TaskFinding[] = [];
  for (const name of files) { const file = `${TASKS_FOLDER}/${name}`; try { tasks.push(parseTask(file, readFileSync(join(folder, file), 'utf8'))); } catch (e) { findings.push({ file, line: 1, message: (e as Error).message }); } }
  return { tasks, findings };
}

export function taskSlug(title: string, scopes: readonly TaskScope[]): string { return taskId(title, scopes.map((scope) => scopeWords(scope))); }

/** Writes one task file whole, and never over another: `wx` refuses a path that exists. */
export function writeTask(folder: string, file: string, task: Omit<PlannedTask, 'id' | 'file'>): void {
  mkdirSync(join(folder, TASKS_FOLDER), { recursive: true });
  writeFileSync(join(folder, file), renderTask(task), { flag: 'wx' });
}
