/**
 * A task closes when a commit closes it (madarch-m38l.14; the owner, 2026-10-23:
 * "у всех документов и кода которого это касается это должны быть видно, что
 * планируются изменения"). Two things close a task: a person, or a commit on the
 * repository's default branch that both names the task and changes its declared
 * scope. A commit that names another task, or that changes only outside the
 * scope, closes nothing.
 *
 * The closure is read from git whenever the tasks are read, so a task file never
 * goes stale against the history it describes. A git read that fails is an error
 * naming the repository, never a task silently left open or closed.
 */

export interface RepositoryRef {
  readonly name: string;
  /** The folder the repository is checked out in. */
  readonly path: string;
}
