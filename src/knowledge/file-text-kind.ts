import { CATALOG_RAW_KINDS } from './catalog-starter.js';

/** The roles a file's text is read by (decision 0037): the entity's repository and path, and the blob git serves. */
export interface FileTextRole {
  /** The catalogue kind, when the catalogue declares one: the kind a product that declares none reads its files by. */
  readonly kind?: string;
  readonly repository: string;
  readonly path: string;
  readonly blob: string;
}

let held: FileTextRole | undefined;

/**
 * The catalogue's own declaration of the kind a repository's files are held as (decision 0037): a product whose manifest
 * declares a `file-text:` role of its own reads by that one, and a product whose manifest predates the decision reads by
 * this. The engine finds the kind and its roles in the catalogue file, never by names of its own.
 */
export function catalogueFileTextRole(): FileTextRole {
  if (held !== undefined) return held;
  for (const [name, raw] of Object.entries(CATALOG_RAW_KINDS)) {
    const role = raw['file-text'];
    if (role === null || typeof role !== 'object' || Array.isArray(role)) continue;
    const roles = role as Record<string, unknown>;
    const repository = roles['repository'];
    const path = roles['path'];
    const blob = roles['blob'];
    if (typeof repository !== 'string' || typeof path !== 'string' || typeof blob !== 'string') {
      throw new Error(`catalog/${name}.yaml:1: the catalogue's "file-text" role names a "repository", a "path" and a "blob" field, got ${JSON.stringify(role)}`);
    }
    held = { kind: name, repository, path, blob };
    return held;
  }
  throw new Error('catalog: none of the catalogue kinds declares a "file-text" role: a file\'s text has no fields to be read by');
}
