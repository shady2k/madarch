/**
 * The task an answer proposes (madarch-m38l.14). The reader chooses «Прав код,
 * документ устарел» or «Прав документ, код нужно исправить»; the engine turns
 * the answer's grounds into a scope a person edits and confirms:
 *
 * - a document section becomes that section, never its whole file (the owner,
 *   2026-10-23: "Зачем помечать весь файл, если исправить нужно одну строчку?");
 * - a whole file or folder becomes the file, because the ground names nothing
 *   narrower; a statement or a symbol keeps its own name;
 * - the grounds that name no place of the product stay the task's grounds, and
 *   a proposal that could derive no scope at all is refused with its grounds.
 *
 * The proposal carries the impact computed through the graph, so the reader sees
 * the pages and statements the change reaches before confirming anything.
 */
import { type TaskImpact } from './impact.js';
import type { PlaceView, TaskScope } from './tasks.js';

/** The reader's choice: the code is right and the documents are old, or the documents are right and the code must change. */
export type TaskChoice = 'code' | 'docs';

export interface TaskProposal {
  readonly choice: TaskChoice;
  readonly title: string;
  readonly grounds: readonly string[];
  readonly scope: readonly TaskScope[];
  /** The places of the scope as a reader says them, one for each scope in the same order (the server adds them). */
  readonly places?: readonly PlaceView[];
  /** What the change reaches, computed through the graph before anything is confirmed. */
  readonly impact: TaskImpact;
  readonly question: { readonly slug: string; readonly title: string; readonly file: string };
  readonly answer: { readonly text: string; readonly by: string; readonly at: string };
}
