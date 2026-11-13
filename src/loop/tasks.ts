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
