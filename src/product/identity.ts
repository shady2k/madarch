/**
 * How one folder is read as a fill's product (madarch-8bdc.2.5): a product's manifest, or a
 * checkout that is no product. One reader, so the fill and every caller that names a
 * repository by the same name agree about it.
 */
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ID_PATTERN } from '../model/schema.js';
import { MANIFEST_FILE, PRODUCT_SCHEMA_VERSION, readProduct, type ProductIdentity } from './manifest.js';

/** How one folder is read as a fill's product: a product's manifest, or a checkout that is no product. */
export interface FillFolderIdentity {
  /** The identity the fill names the folder's repository by. */
  readonly identity: ProductIdentity;
  /** True where the folder holds a product manifest; false for a checkout that is no product. */
  readonly product: boolean;
}

/**
 * The identity a fill reads one folder under. A product's is its manifest's, refused with the
 * manifest's own file, line and words. A checkout that holds no manifest is read as the
 * repository it is: its folder's own name is the name its facts stand under, and it declares
 * no code repository — the workflow reader then runs the engine's starter set, which is what a
 * repository without a workflow runs.
 */
export function fillFolderIdentity(folder: string): FillFolderIdentity {
  const absolute = resolve(folder);
  if (!existsSync(join(absolute, MANIFEST_FILE))) {
    const name = basename(absolute.replace(/[/\\]+$/u, ''));
    if (!ID_PATTERN.test(name)) {
      throw new Error(`the folder ${absolute} holds no ${MANIFEST_FILE} and is named ${JSON.stringify(name)}, which is no repository name: a name a repository is read under starts with a letter or a digit and carries letters, digits, ".", "_" or "-" (serve a folder whose name is one, src/product/identity.ts)`);
    }
    return { product: false, identity: { folder: absolute, id: name, name, schemaVersion: PRODUCT_SCHEMA_VERSION, skills: {}, repos: [] } };
  }
  const read = readProduct(absolute);
  if (!read.ok) throw new Error(`${read.file}:${read.line}: ${read.message}`);
  if (!ID_PATTERN.test(read.product.name)) {
    throw new Error(`the product ${read.product.folder} names itself ${JSON.stringify(read.product.name)}, which is no repository name: a name a repository is read under starts with a letter or a digit and carries letters, digits, ".", "_" or "-" (write "name:" in ${read.product.folder}/workspace.yaml)`);
  }
  return { product: true, identity: read.product };
}
