/**
 * The files PGlite's own build reads from the folder it runs in: its data
 * archive and its two WebAssembly modules (`pglite.data`, `pglite.wasm`,
 * `initdb.wasm`).
 *
 * `madarch` opens the process's one database as PGlite when no PostgreSQL server
 * is configured (decision 0027, "Storage ownership"), so a release binary that
 * carries none of them cannot open it at all: PGlite resolves them against the
 * module it was bundled into, which inside `bun build --compile` is the binary's
 * own root — exactly where `--asset` lays them, and where `Bun.main`'s directory
 * points. `scripts/build-binary.ts` embeds them in the release binary, and the
 * queue's compiled-binary test (`test/queue-binary.test.ts`, madarch-tzte.19.2)
 * stages the same three for the binary it builds, so both read this one list.
 *
 * A missing file is refused by its full path here rather than left to fail
 * inside the database later, where PGlite's own message names neither the file
 * it wanted nor the install that would have put it there.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo's own checkout root, beside which the installed packages stand. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The three files, in the order they are embedded; throws, naming each missing one, when the install is short. */
export function pgliteAssetFiles(): string[] {
  const dist = join(REPO_ROOT, 'node_modules', '@electric-sql', 'pglite', 'dist');
  const files = ['pglite.data', 'pglite.wasm', 'initdb.wasm'].map((name) => join(dist, name));
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`the PGlite build files the binary must carry are not installed: ${missing.join(', ')} (run "bun install --frozen-lockfile")`);
  }
  return files;
}
