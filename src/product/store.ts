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
import { join, resolve } from 'node:path';
import { WikiReadError } from '../knowledge/read-error.js';
import { MANIFEST_FILE } from './manifest.js';
import { fillFolderIdentity } from './identity.js';

/** The knowledge root under one products home: `<products home>/.madarch/knowledge`. */
export function knowledgeRootOf(productsHome: string): string {
  return join(resolve(productsHome), '.madarch', 'knowledge');
}

/**
 * The folder a product's knowledge is kept in: named by the product's id under the knowledge
 * root. An id with a separator or a dot segment would name another place, so it names none.
 */
export function storeFolderOf(knowledgeRoot: string, id: string, manifest: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new WikiReadError(`${manifest}: the product id ${JSON.stringify(id)} cannot name a folder (letters, digits, dots, hyphens and underscores only): the wiki keeps nothing for it`);
  }
  return join(knowledgeRoot, id);
}

/**
 * The one store of one product, or of a checkout that is no product: its id's folder under the
 * knowledge root. A folder that names no store is refused with the manifest's own file and line,
 * or with the folder's name where it holds no manifest.
 */
export function productStoreFolder(productFolder: string, knowledgeRoot: string): string {
  const folder = resolve(productFolder);
  const read = fillFolderIdentity(folder);
  return storeFolderOf(knowledgeRoot, read.identity.id, join(folder, MANIFEST_FILE));
}

/** The database a store's fill writes and its readers read: `<store>/graph`. */
export function storeDatabasePath(storeFolder: string): string {
  return join(storeFolder, 'graph');
}

/** The folder a store's numbered snapshots are made in, which a reader opens: `<store>/read`. */
export function storeSnapshotsFolder(storeFolder: string): string {
  return join(storeFolder, 'read');
}
