/**
 * The wiki app the release build carries inside the compiled madarch binary
 * (madarch-lfhu, decision 0021's one binary; scripts/build-binary.ts embeds
 * `wiki/app/dist` as the asset named `wiki-app` and reads it back through
 * Bun.main's directory, the binary's own root). Serving looks here before
 * the checkout's own app folder: the binary has no checkout, so the asset
 * (with no sources-hash record, arriving pre-built) is what it serves, and
 * a `MADARCH_APP` pointing elsewhere still wins for a deployment that lays
 * the app on disk itself.
 *
 * In a source checkout the module runs beside the sources: the folder this
 * helper names does not exist under `scripts/`, so the answer is undefined
 * and the checkout's own app folder decides, as before.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The root the compiled binary's assets are laid under; `scripts/` in a checkout. */
export function releaseRoot(): string {
  return dirname(Bun.main);
}

/**
 * The embedded wiki app's folder (the one holding `dist/`), when this
 * process is a release binary carrying it: the folder as a path the
 * server's file reads answer; undefined in a source checkout and in a
 * binary that carries no wiki app.
 */
export function embeddedWikiApp(root: string = releaseRoot()): string | undefined {
  const folder = join(root, 'wiki-app');
  if (existsSync(join(folder, 'dist', 'index.html'))) return folder;
  return undefined;
}

/**
 * The release version the binary was built at: the text of the embedded
 * `version` file, when the binary carries one. undefined in a source
 * checkout, where `madarch version` answers `dev` and `madarch upgrade`
 * refuses.
 */
export function releaseVersion(root: string = releaseRoot()): string | undefined {
  try {
    const text = readFileSync(join(root, 'version'), 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    // No file, or one that cannot be read: the checkout answers dev.
    return undefined;
  }
}
