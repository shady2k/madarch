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
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename as nameOf, isAbsolute, join as joinPath, relative } from 'node:path';
import { scanDocument } from '../wiki/documents.js';
import { readProduct, type ProductIdentity } from '../product/manifest.js';
import { byCodePoint } from '../model/order.js';

/** The address prefix of a page's route within the app. */
export const PAGE_ADDRESS_PREFIX = '/p/';

/**
 * A page's address: the prefix plus its path, each segment percent-escaped,
 * so a `#`, a space or a `?` in a file name reaches the route whole instead
 * of being cut off as a fragment or a query.
 */
export function addressOf(path: string): string {
  return PAGE_ADDRESS_PREFIX + path.split('/').map(encodeURIComponent).join('/');
}

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
      pages.push({ path, title: titleOf(path, markdown.markdown), address: addressOf(path) });
    }
    return { ok: true, revision: hash.digest('hex'), pages };
  }

  page(asked: string): ProductWikiPage {
    // An address the wiki itself advertises — `/p/` plus the path, percent
    // escapes included — names the page it was made from, so a reader who
    // copies an address into a document reaches it (finding 12).
    let path = asked;
    if (asked.startsWith(`${PAGE_ADDRESS_PREFIX}/`) || asked === PAGE_ADDRESS_PREFIX.slice(0, -1)) {
      path = asked.slice(PAGE_ADDRESS_PREFIX.length);
    } else if (asked.startsWith(PAGE_ADDRESS_PREFIX)) {
      try {
        path = decodeURIComponent(asked.slice(PAGE_ADDRESS_PREFIX.length));
      } catch {
        return { ok: false, message: `the address ${JSON.stringify(asked)} holds a percent escape the wiki cannot read: ask for the page by its path within the product` };
      }
    }
    const pagePath = pagePathProblem(path);
    if (pagePath !== undefined) {
      return {
        ok: false,
        message: path === asked ? pagePath.message : `the address ${JSON.stringify(asked)} does not name a page of the wiki: ${pagePath.message}`,
      };
    }
    // The walk's own failure — an unreadable folder on the way, a page
    // that is not a regular file — is kept at this boundary as the
    // refusal naming the path and the cause, never rethrown for the
    // handler's generic 500 to swallow (finding 7).
    let held: string[];
    try {
      held = markdownPaths(this.product.folder);
    } catch (error) {
      return { ok: false, message: `the page ${JSON.stringify(path)} could not be read from ${JSON.stringify(this.product.folder)}: ${(error as Error).message}` };
    }
    if (!held.includes(path)) {
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

/**
 * Every Markdown path within the product, `docs/` depth first and `README.md`,
 * nothing else touched. A path that cannot be walked is an error, never a
 * smaller set: absence of `docs/` is the empty wiki, any other read failure
 * (a permission, a wrong type, an I/O error) is thrown naming the full path.
 * A symlink standing in the set's places is followed only when its real path
 * stays inside the product; one that leaves it is refused, naming the path
 * and where it points.
 */
function markdownPaths(productFolder: string): string[] {
  const paths: string[] = [];
  const readme = joinPath(productFolder, 'README.md');
  if (lstatSyncQuiet(readme) !== undefined && inProductOrThrow(productFolder, readme, 'README.md')) {
    paths.push('README.md');
  }
  const docs = joinPath(productFolder, DOCS_FOLDER);
  const docsKind = lstatSyncQuiet(docs);
  if (docsKind === undefined) return paths; // No docs folder at all: no pages of its own.
  if (docsKind.isSymbolicLink()) {
    // A symlink standing where docs/ stands is judged like any page entry:
    // followed only when it lands inside the product's docs/ itself.
    inProductOrThrow(productFolder, docs, DOCS_FOLDER);
    walk(docs);
    return paths;
  }
  if (!docsKind.isDirectory()) {
    throw new Error(`the page folder ${docs} is not a folder: the wiki reads its pages under ${DOCS_FOLDER}/`);
  }
  walk(docs);
  return paths;

  function walk(folder: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`the folder ${folder} cannot be read: ${(error as Error).message}`);
    }
    for (const entry of entries.sort((a, b) => byCodePoint(a.name, b.name))) {
      if (entry.name.startsWith('.')) continue;
      const full = joinPath(folder, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const within = relative(productFolder, full).split('\\').join('/');
      // A non-regular file — a FIFO, a socket, a device — is never opened:
      // opening it could block the server for good, so it is refused by
      // name before the read is even tried (finding 2).
      if (!inProductOrThrow(productFolder, full, within)) {
        throw new Error(`the page ${JSON.stringify(within)} at ${full} is not a regular file: the wiki reads Markdown files only`);
      }
      paths.push(within);
    }
  }
}

/** The entry's `lstat`, or `undefined` when nothing stands there. */
function lstatSyncQuiet(path: string): import('node:fs').Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`the path ${path} cannot be read: ${(error as Error).message}`);
  }
}

/**
 * Whether the page set may read `path` for the page `within`: a real file is
 * read as it stands, and a symlink only when its real target stays in the
 * two permitted places — the `docs/` folder, or the root `README.md` itself.
 * A symlink whose target leaves those places is refused naming the held path
 * and the target it points at: nothing madarch reads may leave `docs/` and
 * `README.md`, even when it stays inside the product's folder.
 */
function inProductOrThrow(productFolder: string, path: string, within: string): boolean {
  const stat = lstatSyncQuiet(path);
  if (stat === undefined) return false;
  if (!stat.isSymbolicLink()) {
    // A plain entry: readable or not, the walk or the read refuses with the cause.
    try {
      return statSync(path).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(`the page ${JSON.stringify(within)} at ${path} cannot be read: ${(error as Error).message}`);
    }
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch (error) {
    throw new Error(`the page ${JSON.stringify(within)} at ${path} is a symlink that cannot be followed: ${(error as Error).message}`);
  }
  const productReal = realpathSync(productFolder);
  const withinReal = joinPath(productReal, DOCS_FOLDER);
  const allowed = real === joinPath(productReal, 'README.md') || real === withinReal || withinReal + '/' === real.slice(0, withinReal.length + 1);
  if (!allowed) {
    throw new Error(
      `the page ${JSON.stringify(within)} at ${path} is a symlink to ${real}, which the page set does not hold: the wiki reads ` +
        `only ${DOCS_FOLDER}/ and README.md; make it a real file, or point the symlink at a Markdown file under ${DOCS_FOLDER}/`,
    );
  }
  return statSync(real).isFile();
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

/**
 * A page's title: its first level-one heading outside a code fence, else its
 * file's name without its extension. The heading rules are the static wiki's
 * `scanDocument` (fences of either tick, indented headings, closing hashes,
 * `#` with no space is no heading): one scanner, one behaviour.
 */
function titleOf(path: string, markdown: string): string {
  const heading = scanDocument(markdown).headings.find((each) => each.level === 1);
  if (heading !== undefined) return heading.text;
  return nameOf(path).replace(/\.md$/, '');
}

/**
 * The wiki's public export beside the server's (src/index.ts has the model
 * side): the app needs nothing else — the server's wiki part reads through
 * `openProductWiki` alone.
 */
export type WikiPageListResult = ProductWikiPages;
