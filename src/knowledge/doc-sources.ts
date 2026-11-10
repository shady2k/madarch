/**
 * The Markdown documents the wiki lists (madarch-m38l.6): the product repository's own and each connected code
 * repository's, as the graph holds them at the commit the fill read. The documents the wiki lists, and the ones the
 * entities of the manifest's document kinds are read from, are the same set: the product's pages (the files of its
 * Markdown kinds) and the documents the manifest excludes are neither. The graph is the one source: `product.ts` reads
 * the paths and the text through `GraphReader`, and `productDocumentPaths` remains only for the product's own
 * working-tree stamps and the reset plan.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { matchesAny, type KindsManifest } from './kinds.js';

/** The endings a Markdown document's name carries: the graph's document query filters on these, and the path rule is theirs. */
export const DOCUMENT_SUFFIXES: readonly string[] = ['.md', '.markdown'];

/** A Markdown document: by its name. */
export const DOCUMENT_PATH = new RegExp(`\\.(${DOCUMENT_SUFFIXES.map((suffix) => suffix.slice(1)).join('|')})$`, 'i');
/** The most documents listed of one repository; a repository with more says how many it has. */
export const DOCUMENT_LIMIT = 2000;

/** The harness files of a coding agent: never listed as a source of the product, wherever they stand. */
export const HARNESS_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

/** A document's title: its first level-one heading, else its file name without the Markdown extension. */
export function documentTitle(markdown: string, path: string): string {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return heading === null ? path.split('/').pop()!.replace(/\.(md|markdown)$/i, '') : heading[1]!.replace(/[*_`]/g, '');
}

/** Whether a path is a page of a Markdown kind of the manifest: its one file, or a file below its folder. */
function isKindPage(manifest: KindsManifest, path: string): boolean {
  for (const decl of manifest.kinds.values()) {
    if (decl.source !== 'markdown') continue;
    if (decl.file !== undefined && decl.file === path) return true;
    if (decl.folder !== undefined && path.startsWith(`${decl.folder.replace(/\/+$/, '')}/`)) return true;
  }
  return false;
}

/** Whether the wiki lists a document of the product repository (`repo` null) or of a code repository: not a page of a kind, not excluded. */
export function listedDocument(manifest: KindsManifest, repo: string | null, path: string): boolean {
  if (repo === null && isKindPage(manifest, path)) return false;
  // Machine-generated entity translations are data for entity pages, not new source documents.
  if (repo === null && /^docs\/sources\/[A-Za-z0-9._-]+\/[A-Za-z0-9_-]+\.md$/.test(path)) return false;
  // «Не проблема» records are loop files, not documents the wiki reads (madarch-m38l.19).
  if (repo === null && /^docs\/problems\/[^/]+\.md$/.test(path)) return false;
  return !matchesAny(manifest.excludeDocuments, path);
}

/** Where the product's `docs` folder really is when it is a link out of the product repository; undefined when it is inside or absent. */
function docsLinkedOutside(productFolder: string): string | undefined {
  try {
    const real = realpathSync(join(productFolder, 'docs'));
    const root = realpathSync(productFolder);
    return real === root || real.startsWith(`${root}${sep}`) ? undefined : real;
  } catch {
    return undefined;
  }
}

/** The product repository's Markdown documents, `/`-separated and in code point order; a `docs` folder that links out of the product is not walked. */
export function productDocumentPaths(productFolder: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, relativeFolder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))) {
      if (entry.name.startsWith('.')) continue;
      const relative = relativeFolder === '' ? entry.name : `${relativeFolder}/${entry.name}`;
      if (entry.isDirectory()) walk(join(folder, entry.name), relative);
      else if (entry.isFile() && DOCUMENT_PATH.test(entry.name)) found.push(relative);
    }
  };
  for (const entry of readdirSync(productFolder, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))) {
    if (entry.isFile() && DOCUMENT_PATH.test(entry.name) && !entry.name.startsWith('.')) found.push(entry.name);
  }
  if (existsSync(join(productFolder, 'docs')) && docsLinkedOutside(productFolder) === undefined) walk(join(productFolder, 'docs'), 'docs');
  return found;
}
