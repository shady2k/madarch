/**
 * A product's pages, read from its working tree on every ask
 * (docs/changes/draft-product/capabilities/product-wiki.md, requirements
 * `pages`, `live` and `result`): every Markdown file under the product's
 * `docs/` folder, at any depth, and `README.md` at its root when it has one.
 * Every other folder — the skill set's tracker at `.beads/`, every other
 * dot-folder, `skills/` and the rest — is neither a page nor read.
 *
 * Nothing is cached: the pages, a page's text and the revision are read
 * from disk again with every call, so what the working tree holds is what
 * the wiki serves, as soon as it holds it. The revision digests the pages'
 * paths and contents, so an unchanged wiki always gives the same revision
 * and is never shown as changed. Asking changes nothing in the product —
 * no write, no git command.
 *
 * The pages are named in code point order of their paths within the
 * product (`byCodePoint`), never the locale's. A page's title is its first
 * level-one heading outside a code fence, else its file's name without its
 * extension, and its address is `/p/` plus its path within the product —
 * the address the app's own routes answer.
 *
 * Refusals are values, named the way this project names them: the exact
 * path asked for, and why the wiki does not hold it. A product whose
 * manifest cannot be read is refused by `readProduct`, never re-read here.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename as nameOf, isAbsolute, join as joinPath, relative, resolve } from 'node:path';
import { readProduct, type ProductIdentity } from '../product/manifest.js';
import { byCodePoint } from '../model/order.js';

/** The address prefix of a page's route within the app. */
export const PAGE_ADDRESS_PREFIX = '/p/';

/** The folder the wiki reads its pages from, inside the product. */
export const DOCS_FOLDER = 'docs';

/** One page as the pages list names it. */
export interface WikiPageEntry {
  /** The page's path within the product, like `docs/vision.md` or `README.md`. */
  path: string;
  /** The page's title: its first level-one heading, else its file's name. */
  title: string;
  /** The address the app answers the page at, like `/p/docs/vision.md`. */
  address: string;
}

/** One page asked for, whole. */
export interface WikiPage {
  path: string;
  title: string;
  markdown: string;
}

/** The wiki's pages as one ask found them. */
export type ProductWikiPages =
  | { ok: true; revision: string; pages: WikiPageEntry[] }
  | { ok: false; message: string };

/** One page as one ask found it, or the refusal naming the path asked for. */
export type ProductWikiPage =
  | { ok: true; page: WikiPage }
  | { ok: false; message: string };

/** One product folder opened as a wiki, or the refusal `readProduct` named. */
export type OpenedProductWiki =
  | { ok: true; wiki: ProductWiki }
  | { ok: false; file: string; line: number; message: string };

/** A read product folder's pages, asked one at a time, always fresh. */
export interface ProductWiki {
  /** The product the wiki serves, as its manifest names it. */
  readonly product: ProductIdentity;
  /** Every page the product holds now, in code point order of their paths, read from disk now. */
  pages(): ProductWikiPages;
  /** One page by its path within the product, read from disk now. */
  page(path: string): ProductWikiPage;
}

/** Opens a product folder as a wiki; a folder whose manifest cannot be read is refused by `readProduct`. */
export function openProductWiki(productFolder: string): OpenedProductWiki {
  const read = readProduct(productFolder);
  if (!read.ok) {
    return { ok: false, file: read.file, line: read.line, message: read.message };
  }
  return { ok: true, wiki: new FreshProductWiki(read.product) };
}

class FreshProductWiki implements ProductWiki {
  constructor(readonly product: ProductIdentity) {}

  pages(): ProductWikiPages {
    let paths: string[];
    try {
      paths = markdownPaths(this.product.folder);
    } catch (error) {
      return { ok: false, message: `the pages of the product ${JSON.stringify(this.product.folder)} could not be read: ${(error as Error).message}` };
    }
    paths.sort(byCodePoint);
    const pages: WikiPageEntry[] = [];
    const hash = createHash('sha256');
    for (const path of paths) {
      const markdown = this.fileText(path);
      if (!markdown.ok) return markdown;
      hash.update(`${path}\u0000${markdown.markdown}\u0000`);
      pages.push({ path, title: titleOf(path, markdown.markdown), address: `${PAGE_ADDRESS_PREFIX}${path}` });
    }
    return { ok: true, revision: hash.digest('hex'), pages };
  }

  page(path: string): ProductWikiPage {
    const pagePath = pagePathProblem(path);
    if (pagePath !== undefined) return pagePath;
    if (!markdownPaths(this.product.folder).includes(path)) {
      return {
        ok: false,
        message: `the wiki does not hold ${JSON.stringify(path)}: a page is every Markdown file under ${DOCS_FOLDER}/ and ${'README.md'} at the product's root`,
      };
    }
    const markdown = this.fileText(path);
    if (!markdown.ok) return markdown;
    return { ok: true, page: { path, title: titleOf(path, markdown.markdown), markdown: markdown.markdown } };
  }

  /** One page's bytes, read from disk now — or the refusal that reading gave. */
  private fileText(path: string): { ok: true; markdown: string } | { ok: false; message: string } {
    try {
      return { ok: true, markdown: readFileSync(joinPath(this.product.folder, ...path.split('/')), 'utf8') };
    } catch (error) {
      return { ok: false, message: `the page ${JSON.stringify(path)} could not be read from ${JSON.stringify(this.product.folder)}: ${(error as Error).message}` };
    }
  }
}

/** Every Markdown path within the product, `docs/` depth first and `README.md`, nothing else touched. */
function markdownPaths(productFolder: string): string[] {
  const paths: string[] = [];
  const readme = joinPath(productFolder, 'README.md');
  if (isFile(readme)) paths.push('README.md');
  const docs = joinPath(productFolder, DOCS_FOLDER);
  const walk = (folder: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return; // No docs folder (or one this ask cannot walk): no pages of its own.
    }
    for (const entry of entries.sort((a, b) => byCodePoint(a.name, b.name))) {
      if (entry.name.startsWith('.')) continue;
      const full = joinPath(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) paths.push(relative(productFolder, full).split('\\').join('/'));
    }
  };
  walk(docs);
  return paths;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A page path the wiki refuses before it looks anything up: absolute, empty, or climbing out of the product. */
function pagePathProblem(path: string): { ok: false; message: string } | undefined {
  if (path.length === 0 || isAbsolute(path) || path.startsWith('/')) {
    return { ok: false, message: `the path ${JSON.stringify(path)} is not a path within the product: ask for a page by its path within the product, like ${JSON.stringify(`${DOCS_FOLDER}/vision.md`)}` };
  }
  if (path.split('/').includes('..')) {
    return { ok: false, message: `the path ${JSON.stringify(path)} climbs out of the product: ask for a page by its path within the product` };
  }
  return undefined;
}

/** A page's title: its first level-one heading outside a code fence, else its file's name without its extension. */
function titleOf(path: string, markdown: string): string {
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const heading = /^#(?!#)\s*(\S.*?)\s*$/.exec(line);
      if (heading !== null) return heading[1]!;
    }
  }
  return nameOf(path).replace(/\.md$/, '');
}

/**
 * The wiki's public export beside the server's (src/index.ts has the model
 * side): the app needs nothing else — the server's wiki part reads through
 * `openProductWiki` alone.
 */
export type WikiPageListResult = ProductWikiPages;
