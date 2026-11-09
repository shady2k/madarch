/**
 * One product's one store (madarch-8bdc.2.5): the folder the fill writes and every reader reads.
 *
 * The button, `madarch fill`, `madarch fill-stages`, the daemon's updates and `madarch mcp` all
 * resolve their store here, and none of them names another one. The store lies under the
 * knowledge root of the products home: `<products home>/.madarch/knowledge/<product id>`, its
 * database at `<store>/graph`, the snapshots a reader opens at `<store>/read`, the fill runs'
 * traces at `<store>/traces`.
 *
 * The id is the manifest's `id:`; a checkout that is no product is named by its folder's name,
 * which is the name the one fill reads its facts under too (`fillFolderIdentity`). The choice of
 * folder stays here, so a store kept by another owner (a PostgreSQL server with one data folder
 * per store) changes this module and no caller.
 */
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { WikiReadError } from '../knowledge/read-error.js';
import { ID_PATTERN } from '../model/schema.js';
import { MANIFEST_FILE, readProduct } from './manifest.js';

/** The knowledge root under one products home: `<products home>/.madarch/knowledge`. */
export function knowledgeRootOf(productsHome: string): string {
  return join(resolve(productsHome), '.madarch', 'knowledge');
}

/**
 * The folder a product's knowledge is kept in: named by the product's id under the knowledge
 * root. An id with a separator or a dot segment would name another place, so it names none.
 */
function storeFolderOf(knowledgeRoot: string, id: string, manifest: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new WikiReadError(`${manifest}: the product id ${JSON.stringify(id)} cannot name a folder (letters, digits, dots, hyphens and underscores only): the wiki keeps nothing for it`);
  }
  return join(knowledgeRoot, id);
}

/**
 * The one store of one product, or of a checkout that is no product: its id's folder under the
 * knowledge root. The store is named by the product's *id* — the one field a manifest keeps for
 * its life — so a product whose display name is no repository name (a name a fill would refuse
 * as a repository's) still has its store, and its readers read it. A manifest that does not read
 * is refused with its own file and line; a folder that holds no manifest is named by its folder's
 * name, which is the name its fill reads it under too.
 */
export function productStoreFolder(productFolder: string, knowledgeRoot: string): string {
  const folder = resolve(productFolder);
  if (!existsSync(join(folder, MANIFEST_FILE))) {
    const name = basename(folder.replace(/[/\\]+$/u, ''));
    if (!ID_PATTERN.test(name)) {
      throw new WikiReadError(`${folder}: the folder holds no ${MANIFEST_FILE} and is named ${JSON.stringify(name)}, which cannot name a store (letters, digits, dots, hyphens and underscores only): nothing is kept for it`);
    }
    return storeFolderOf(knowledgeRoot, name, join(folder, MANIFEST_FILE));
  }
  const read = readProduct(folder);
  if (!read.ok) throw new Error(`${read.file}:${read.line}: ${read.message}`);
  return storeFolderOf(knowledgeRoot, read.product.id, join(folder, MANIFEST_FILE));
}

/** The database a store's fill writes and its readers read: `<store>/graph`. */
export function storeDatabasePath(storeFolder: string): string {
  return join(storeFolder, 'graph');
}

