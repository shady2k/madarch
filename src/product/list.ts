/**
 * Listing the products a products home holds — `madarch list` (decision
 * 0019: madarch serves and lists any folder with a valid `workspace.yaml`,
 * whoever made it, and keeps `madarch list` its own). The products home is
 * resolved the way `madarch new` resolves it; the products are its direct
 * subfolders whose manifest reads, in the project's code point order of
 * their paths.
 *
 * A subfolder that holds no `workspace.yaml` is not a product and is not
 * listed: the home is where madarch writes products, and nothing there is
 * a product madarch cannot recognise. A subfolder whose manifest is there
 * but cannot be read is named in the result with the reader's own words,
 * file and line included — the list still prints every product it did read,
 * and the command shows the refusals on standard error; hiding a broken
 * draft would say a folder is fine that nobody looked at.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readProduct, MANIFEST_FILE } from './manifest.js';
import type { ProductIdentity } from './manifest.js';
import { productsHome, type DraftEnv } from './draft.js';
/**
 * The folders' own order: code point by code point, not by UTF-16 code unit.
 * A name holding a character above the Basic Multilingual Plane (U+10000
 * and up, written as a surrogate pair in a JavaScript string) must fall
 * where its code point falls — between the private-use U+F8FF and U+FFFD —
 * and the plain `<`/`>` comparison reads the pair's high half first and
 * puts it before U+E000. The list's order is the reader's, and it is the
 * one the capability names.
 */
function folderCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    // The characters' code points, as numbers: comparing the one-character
    // strings with `<` would compare their UTF-16 units again, and a
    // character above the basic plane is a surrogate pair in them.
    if (left[i] !== right[i]) {
      const lp = left[i]!.codePointAt(0)!;
      const rp = right[i]!.codePointAt(0)!;
      return lp < rp ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/** A manifest that stands but cannot be read, named so the list hides nothing. */
export interface UnreadableProduct {
  /** The full path of the folder whose manifest cannot be read. */
  folder: string;
  /** The manifest's file and line, and the reason, as the reader named them. */
  file: string;
  line: number;
  message: string;
}

/** How listing a products home ended. `refused` is the command's exit 2. */
export type ProductList =
  | { outcome: 'listed'; products: ProductIdentity[]; unreadable: UnreadableProduct[] }
  | { outcome: 'refused'; message: string };

export interface ListOptions {
  /** The products home, as `--home` names it for this one command; `MADARCH_HOME` and the default as `madarch new` decides them. */
  home?: string;
}

/** Lists the products of the products home: every subfolder whose manifest reads, in the code point order of their paths. */
export function listProducts(options: ListOptions = {}): ProductList {
  const home = resolve(productsHome(process.env as DraftEnv, options.home));

  // A home that is a file, or one that cannot be looked at, is refused; an
  // absent home is a person who never created a product, and reads as an
  // empty list — the difference is the error's own cause, never its text.
  try {
    const stats = statSync(home);
    if (!stats.isDirectory()) {
      return { outcome: 'refused', message: `the products home ${home} cannot be listed: a file of that name is in the way — point the command at another home` };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { outcome: 'listed', products: [], unreadable: [] };
    }
    return { outcome: 'refused', message: `the products home ${home} cannot be listed: ${(error as Error).message}` };
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch (error) {
    return { outcome: 'refused', message: `the products home ${home} could not be listed: ${(error as Error).message}` };
  }

  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(folderCodePoints);
  const products: ProductIdentity[] = [];
  const unreadable: UnreadableProduct[] = [];
  for (const name of folders) {
    const folder = join(home, name);
    // A folder with no manifest at all is nothing this home holds as a
    // product; a folder whose manifest cannot even be reached is the
    // reader's refusal, never a quiet skip.
    try {
      statSync(join(folder, MANIFEST_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    }
    const read = readProduct(folder);
    if (read.ok) products.push(read.product);
    else unreadable.push({ folder, file: read.file, line: read.line, message: read.message });
  }
  return { outcome: 'listed', products, unreadable };
}
