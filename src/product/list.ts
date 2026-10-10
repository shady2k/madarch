/**
 * Listing the products a products home holds — `madarch list` (decision
 * 0019: madarch serves and lists any folder with a valid `workspace.yaml`,
 * whoever made it, and keeps `madarch list` its own). The products home is
 * resolved the way `madarch new` resolves it; the products are its direct
 * subfolders whose manifest reads, in code point order of their paths.
 *
 * A subfolder that holds no `workspace.yaml` is not a product and is not
 * listed: the home is where madarch writes products, and nothing there is
 * a product madarch cannot recognise. A subfolder whose manifest is there
 * but cannot be read is named in the result — the list still prints every
 * product it did read, and the command shows the refusals on standard
 * error; hiding a broken draft would say a folder is fine that nobody
 * looked at.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readProduct, MANIFEST_FILE } from './manifest.js';
import type { ProductIdentity } from './manifest.js';
import { productsHome, type DraftEnv } from './draft.js';

/** One product folder the list read, or one it could not. */
export interface ListedProduct {
  /** The product's folder, id, name, schema version and declared fields, as the manifest reader gives them. */
  product: ProductIdentity;
}

/** A manifest that stands but cannot be read, named so the list hides nothing. */
export interface UnreadableProduct {
  /** The full path of the folder whose manifest cannot be read. */
  folder: string;
  /** The manifest's file, the line and the reason, as the reader named them. */
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

/** Lists the products of the products home: every subfolder whose manifest reads, in code point order. */
export function listProducts(options: ListOptions = {}): ProductList {
  const home = resolve(productsHome(process.env as DraftEnv, options.home));

  // A home that is not a folder is refused: a file of that name is in the
  // way, and nothing can be listed under it.
  try {
    const stats = statSync(home);
    if (!stats.isDirectory()) {
      return { outcome: 'refused', message: `the products home ${home} cannot be listed: a file of that name is in the way — point the command at another home` };
    }
  } catch {
    // Absent: a person who never created a product has an empty list, not an error.
    return { outcome: 'listed', products: [], unreadable: [] };
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch (error) {
    return { outcome: 'refused', message: `the products home ${home} could not be listed: ${(error as Error).message}` };
  }

  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(byCodePoint);
  const products: ProductIdentity[] = [];
  const unreadable: UnreadableProduct[] = [];
  for (const name of folders) {
    const folder = join(home, name);
    if (!existsSync(join(folder, MANIFEST_FILE))) continue; // no manifest: not a product of this home.
    const read = readProduct(folder);
    if (read.ok) products.push(read.product);
    else unreadable.push({ folder, file: read.file, line: read.line, message: read.message });
  }
  return { outcome: 'listed', products, unreadable };
}

/** Two paths in code point order, the order every list in this project is printed in. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
