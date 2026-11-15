/**
 * The wiki app the release build carries inside the compiled madarch binary
 * (madarch-lfhu, decision 0021's one binary; scripts/build-binary.ts embeds
 * `wiki/app/dist` as the asset named `wiki-app` and reads it back from the
 * bundle's own root). Serving looks here before the checkout's own app folder:
 * the binary has no checkout, so the asset (with no sources-hash record,
 * arriving pre-built) is what it serves, and a `MADARCH_APP` pointing elsewhere
 * still wins for a deployment that lays the app on disk itself.
 *
 * The root is this module's own: three folders above `src/product-wiki` is the
 * checkout — whose `wiki-app` does not exist — or the bundle's root, where the
 * asset stands. `Bun.main` is deliberately not read: a binary built with a
 * second entry (the read worker, which also draws archify diagrams) names that
 * worker's file, so `Bun.main` answered a folder with no assets and the release
 * carried the vendored renderer unseen (madarch-64o5.97).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the caller may say about this program's own module, for a test that cannot build a release binary. */
export interface ReleaseRootReadings {
  /** This module's URL, the one a bundle lays under its root; `import.meta.url` when it is left out. */
  readonly moduleUrl?: string;
}

/**
 * The root the compiled binary's assets are laid under; the checkout's root in a source run. A bundle mounts its
 * assets at `$bunfs/root` (`~BUN\root` on Windows) whatever folder the module itself is laid in; a source checkout
 * reads three folders above `src/product-wiki`. `Bun.main` is not read: with a second entry it names that entry's file.
 */
export function releaseRoot(readings: ReleaseRootReadings = {}): string {
  const modulePath = fileURLToPath(readings.moduleUrl ?? import.meta.url);
  const bundle = /^(.*?[\\/](?:\$bunfs|~BUN)[\\/]root)/u.exec(modulePath)?.[1];
  return bundle ?? dirname(dirname(dirname(modulePath)));
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

/**
 * The pinned copy of madarch's own wiki the release binary carries (decision 0031): a git bundle of the madarch product
 * repository at the revision `own-wiki.lock` names, with the revision beside it. undefined in a source checkout and in a
 * binary built without it, where the first start fetches the repository instead.
 */
export function embeddedOwnWiki(root: string = releaseRoot()): { bundle: string; revision: string } | undefined {
  const folder = join(root, 'own-wiki');
  try {
    const revision = readFileSync(join(folder, 'REVISION'), 'utf8').trim();
    if (revision !== '' && existsSync(join(folder, 'madarch-product.bundle'))) return { bundle: join(folder, 'madarch-product.bundle'), revision };
  } catch {
    // no copy embedded: the checkout's first start fetches it
  }
  return undefined;
}
