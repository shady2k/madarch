/**
 * The file, line and column an error is raised from (the quality rule every
 * artifact follows: a failure names its file, its line and its full path).
 *
 * Run from source, the path is the file's own absolute path; bundled — the
 * shipped `bun build --compile` binary, where `import.meta.url` is
 * `/$bunfs/root/<binary>` — it is the source path of the file whose frames are
 * reported, and the line and column are the bundle's, because a bundle carries
 * no source map. Either way an error names a path and never a bare `Error`.
 *
 * The fill's state machines (`src/fill/fsm-core.ts`) use the same helper, and
 * re-export it, so the two modules cannot drift apart.
 */
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = 'src/model/raise.ts';
const MODULE_PATH = import.meta.url.startsWith('file:') && !fileURLToPath(import.meta.url).startsWith('/$bunfs')
  ? fileURLToPath(import.meta.url)
  : SOURCE_PATH;

/** The stack frames of the helpers below: a frame that only returns another call is skipped by name. */
const LOCATING_HELPERS = new Set(['throwSite', 'raise', 'here']);

/** The file, line and column of the first frame above the locating helpers. */
function throwSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  for (const frame of frames) {
    const located = /\(?([^\s()]+):(\d+):(\d+)\)?\s*$/.exec(frame.trim());
    if (located === null) continue;
    const name = /^\s*at\s+([^\s(]+)/.exec(frame)?.[1] ?? '';
    if (LOCATING_HELPERS.has(name)) continue;
    return `${located[1]}:${located[2]}:${located[3]}`;
  }
  return MODULE_PATH;
}

/** Raises an error that names the file, line and column it was raised from, then what is wrong. */
export function raise(message: string): never {
  throw new Error(`${throwSite()}: ${message}`);
}

/** The file, line and column of the statement that calls this helper. */
export function here(): string {
  return throwSite();
}
