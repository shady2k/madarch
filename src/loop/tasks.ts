/** Product-owned scoped tasks proposed from answers (madarch-m38l.14). */
import type { Author } from './entities.js';

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
