/**
 * The product repository's own files as one read sees them (madarch-hsqs stage C): the fill's working tree while the
 * files producer reads the source, and the graph's stored text for every reader of the wiki. One interface, so a reader
 * of the manifest, the Markdown entities, the templates and the loop cannot tell which source stands behind it — except
 * that the graph's never touches the checkout.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { byCodePoint } from '../model/order.js';

/** How a read of the product repository's own files reads them. */
export interface ProductFileRead {
  /** Whether the source holds this path as a file. */
  has(path: string): boolean;
  /** The file's text; `undefined` when the source holds none (a binary file, or no content stored). */
  text(path: string): string | undefined;
  /** The file's size in bytes, when the source states it: the caps are read before a file is held. */
  size(path: string): number | null;
}

/** A source that can also list its files: the Markdown entities and the loop's folders are found by listing them. */
export interface ProductFileSource extends ProductFileRead {
  /** Fetches the text of these paths, once each: the graph's source reads the store, and the working tree needs nothing. */
  ensure(paths: readonly string[]): Promise<void>;
  /** The files directly in a folder, `/`-separated paths from the product root, in code point order. */
  filesIn(folder: string): string[];
  /** Every file below a folder, at any depth, in code point order. */
  filesBelow(folder: string): string[];
  /** Every path of the repository's tree, in code point order. */
  paths(): string[];
}

/**
 * The product folder's working tree as a source: the fill reads the source through this, and a test's fixture reads the
 * files it wrote. Never a reader of a page — that one reads the graph (`src/plugin/product-source.ts`).
 */
export function workingTreeFiles(productFolder: string): ProductFileSource {
  return {
    has: (path) => {
      try {
        return lstatSync(join(productFolder, path)).isFile();
      } catch {
        return false;
      }
    },
    text: (path) => {
      try {
        return readFileSync(join(productFolder, path), 'utf8');
      } catch {
        return undefined;
      }
    },
    ensure: async () => undefined,
    size: (path) => {
      try {
        const stat = lstatSync(join(productFolder, path));
        return stat.isFile() ? stat.size : null;
      } catch {
        return null;
      }
    },
    filesIn: (folder) => {
      try {
        return readdirSync(join(productFolder, folder), { withFileTypes: true })
          .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
          .map((entry) => `${folder.replace(/\/+$/, '')}/${entry.name}`)
          .sort();
      } catch {
        return [];
      }
    },
    paths: () => {
      const found: string[] = [];
      const walk = (directory: string): void => {
        let entries;
        try {
          entries = readdirSync(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const full = join(directory, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) found.push(relative(productFolder, full).split('\\').join('/'));
        }
      };
      walk(productFolder);
      return found.sort();
    },
    filesBelow: (folder) => {
      const root = join(productFolder, folder);
      // A folder that is a link is somebody else's tree, wherever it points: nothing below it is this product's file.
      try {
        if (lstatSync(root).isSymbolicLink()) return [];
      } catch {
        return [];
      }
      const found: string[] = [];
      const walk = (directory: string): void => {
        let entries;
        try {
          entries = readdirSync(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of [...entries].sort((left, right) => byCodePoint(left.name, right.name))) {
          if (entry.isSymbolicLink()) continue;
          const full = join(directory, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) found.push(relative(productFolder, full).split('\\').join('/'));
        }
      };
      walk(root);
      return found.sort();
    },
  };
}

/** One entry of a pinned tree, as the fill's snapshot reader states it. */
interface SnapshotEntryLike {
  readonly path: string;
  readonly mode: string;
  readonly form: string;
  readonly bytes?: number;
}

/**
 * A product repository at the commit a fill pins, as a source of its files: the fill reads the declaration files it
 * stores from this tree, never from the working tree, so a fill that stores a commit and a reader that reads the graph
 * see the same bytes (madarch-hsqs stage C).
 */
export async function snapshotFiles(reader: { entries(): readonly SnapshotEntryLike[]; readTexts(paths: readonly string[]): Promise<readonly string[]> }): Promise<ProductFileSource> {
  const entries = new Map<string, SnapshotEntryLike>();
  for (const entry of reader.entries()) {
    // A symlink is a blob whose bytes are its target: no read follows one, as every reader of the tree skips them.
    if (entry.mode === '120000') continue;
    entries.set(entry.path, entry);
  }
  const held = new Map<string, string | null>();
  return {
    has: (path) => entries.has(path),
    size: (path) => entries.get(path)?.bytes ?? null,
    text: (path) => {
      if (!held.has(path)) {
        throw new Error(`${path}: the file was not read from the pinned tree by this fill: a reader asks the stored files through the source itself (src/plugin/product-files.ts)`);
      }
      return held.get(path) ?? undefined;
    },
    ensure: async (paths) => {
      const pending = [...new Set(paths)].filter((path) => !held.has(path)).sort(byCodePoint);
      if (pending.length === 0) return;
      const blobs = pending.filter((path) => entries.get(path)?.form === 'blob');
      const texts = await reader.readTexts(blobs);
      if (texts.length !== blobs.length) {
        throw new Error(`${blobs[0] ?? '(empty batch)'}: the pinned tree answered ${texts.length} files for ${blobs.length} requested paths`);
      }
      for (const path of pending) held.set(path, null);
      for (let at = 0; at < blobs.length; at++) held.set(blobs[at]!, texts[at]!);
    },
    filesIn: (folder) => {
      const prefix = folder.replace(/\/+$/, '') + '/';
      return [...entries.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).sort();
    },
    filesBelow: (folder) => {
      const prefix = folder.replace(/\/+$/, '') + '/';
      return [...entries.keys()].filter((path) => path.startsWith(prefix)).sort();
    },
    paths: () => [...entries.keys()].sort(),
  };
}
