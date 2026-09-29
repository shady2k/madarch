/**
 * The page-id → project file mapping both engine writers share: every
 * writer lays its pages out the same way under its own content folder, so
 * one mapping serves both (`docs/` for Zensical, `src/content/docs/` for
 * Starlight, each writer joining its own root onto these paths).
 */

/** The folder a prefixed page id lives in, one level under the content root. */
const FOLDER_BY_PREFIX: Record<string, string> = { domain: 'domains', element: 'elements', zone: 'zones', 'data-category': 'data-categories' };

/** Pages that sit directly under the content root: the interfaces page and the zones and data categories indexes. */
const PATH_BY_TOP_LEVEL_ID: Record<string, string> = { interfaces: 'interfaces.md', zones: 'zones.md', 'data-categories': 'data-categories.md' };

/**
 * The project-relative file a page id is written to: `home` is the site's
 * index, a top-level id its own file under the content root, and a
 * `<kind>/<id>` id (`domain/`, `element/`, `zone/`, `data-category/`) a
 * file in its kind's folder. Throws for an id no writer
 * has a place for, so a new page kind cannot silently build into the
 * wrong place.
 */
export function pagePath(id: string): string {
  if (id === 'home') return 'index.md';
  const topLevel = PATH_BY_TOP_LEVEL_ID[id];
  if (topLevel !== undefined) return topLevel;
  const slash = id.indexOf('/');
  if (slash < 0) throw new Error(`page id "${id}" has no kind prefix: expected "home", a top-level page id or "<kind>/<id>"`);
  const folder = FOLDER_BY_PREFIX[id.slice(0, slash)];
  if (folder === undefined) throw new Error(`page id "${id}" names an unknown kind: no folder is mapped for "${id.slice(0, slash)}"`);
  return `${folder}/${id.slice(slash + 1)}.md`;
}
