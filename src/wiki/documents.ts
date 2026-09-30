/**
 * The repository's own documents as wiki pages (docs/changes/wiki/capabilities/wiki.md,
 * requirement `documents`): `README.md`, every Markdown file under `docs/`,
 * and the review report beside the model when there is one. Each document
 * becomes a `document/…` page whose body is the file's Markdown whole, with
 * a title where the document has none, and its links resolved — an inline
 * one, with its title or in angle brackets, a reference definition, a
 * root-relative one — to another document's page, to an image the build
 * copies into the site, or left as written: an external scheme, a
 * `#anchor` of the same page, a protocol-relative link. A link to
 * anything else is broken: the build refuses it, naming the document, the
 * line and the target, all of them at once (requirement `links`).
 * Markdown outside README.md and docs/ is out of scope, so a link into it
 * is broken too, never silently kept.
 *
 * The scan a document page is built from is exported for the writers: they
 * walk the same links and Mermaid fences when they rewrite the body.
 */
import { byCodePoint, type WikiDocumentLink, type WikiDocumentPage } from './pages.js';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname as dirOf, isAbsolute, join as joinPath, normalize, relative } from 'node:path';

/** Files a document link may point at and be copied into the site: what a reader's browser shows. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/;

/** One inline link or image of a document, found in the body. */
export interface ScannedLink {
  /** The link target exactly as written, parentheses excluded. */
  readonly written: string;
  /** Where the target starts in the body, for the writers' in-place rewrite. */
  readonly start: number;
  /** Where the target ends: `body.slice(start, end)` is the target. */
  readonly end: number;
  /** The 1-based body line the link sits on, named by the broken-link report. */
  readonly line: number;
}

/** One ATX heading outside code fences, its level (1–6) and its text. */
export interface ScannedHeading {
  readonly level: number;
  readonly text: string;
}

/** One ```mermaid fence: its source lines, and where the whole fence sits in the body. */
export interface ScannedMermaid {
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

/** What one document's Markdown holds: its headings, its links, its Mermaid fences, and every code region. */
export interface DocumentScan {
  readonly headings: readonly ScannedHeading[];
  readonly links: readonly ScannedLink[];
  readonly mermaid: readonly ScannedMermaid[];
  /** Inline code spans and fenced blocks, any language: the regions whose `<` is code, never markup. */
  readonly code: readonly ScannedCode[];
}

/** One code region of the body — a code span or a fence — its whole extent. */
export interface ScannedCode {
  /** Where the code starts: the first backtick, or the fence's opening line. */
  readonly start: number;
  /** Where it ends: past the closing run or the fence's last line. */
  readonly end: number;
}

/** One broken link of the documents: who wrote it, as written, and what it names. */
export interface BrokenDocumentLink {
  /** The document carrying the link, as a repository path. */
  readonly source: string;
  /** The link exactly as the document wrote it. */
  readonly written: string;
  /** The repository path the link resolves to. */
  readonly target: string;
  /** The 1-based line of the document the link sits on. */
  readonly line: number;
}

/**
 * The documents' broken links, all of them: thrown after the whole document
 * set is read, so one broken link never hides another. The message names
 * each document and the target it misses, sorted by code point.
 */
export class DocumentLinkError extends Error {
  readonly broken: readonly BrokenDocumentLink[];

  constructor(broken: readonly BrokenDocumentLink[]) {
    super(
      [
        'the documents carry broken links:',
        ...broken.map(
          (link) => `${link.source}:${link.line}: links to "${link.written}" — ${link.target} is not a page of this wiki; fix the link or add the document`,
        ),
      ].join('\n'),
    );
    this.name = 'DocumentLinkError';
    this.broken = broken;
  }
}

export function scanDocument(body: string): DocumentScan {
  const headings: ScannedHeading[] = [];
  const links: ScannedLink[] = [];
  const mermaid: ScannedMermaid[] = [];
  const code: ScannedCode[] = [];
  const lines = body.split('\n');
  let offset = 0;
  let fence: { char: string; length: number; mermaid: boolean; contentStart: number; fenceStart: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (fence !== undefined) {
      const close = trimmed.match(/^(`{3,}|~{3,})$/);
      if (close !== null && close[0]![0] === fence.char && close[0]!.length >= fence.length) {
        if (fence.mermaid) mermaid.push({ source: body.slice(fence.contentStart, start > fence.contentStart && body[start - 1] === '\n' ? start - 1 : start), start: fence.fenceStart, end });
        code.push({ start: fence.fenceStart, end });
        fence = undefined;
      }
      continue;
    }
    const open = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (open !== null) {
      fence = { char: open[1]![0]!, length: open[1]!.length, mermaid: open[2]!.trim() === 'mermaid', contentStart: end + 1, fenceStart: start };
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/);
    if (heading !== null) {
      const text = (heading[2] ?? '').replace(/\s+#+\s*$/, '').trim();
      if (text !== '') headings.push({ level: heading[1]!.length, text });
      continue;
    }
    const definition = line.match(/^ {0,3}\[([^\]]+)\]:[ \t]*/);
    if (definition !== null) {
      // A link reference definition: its destination is the link the
      // engines render every `[text][label]` use from, so it is recorded
      // like an occurrence of its own, resolved and rewritten there.
      const rest = line.slice(definition[0].length);
      const destination = parseDestination(rest);
      if (destination.text.trim() !== '') {
        const base = start + definition[0].length;
        links.push({ written: destination.text, start: base + destination.start, end: base + destination.end, line: lineNumber });
        continue;
      }
    }
    scanLineLinks(line, start, links, code, lineNumber);
  }
  // A fence never closed runs to the end of the body; its content is code
  // all the way.
  if (fence !== undefined) code.push({ start: fence.fenceStart, end: body.length });
  return { headings, links, mermaid, code };
}

/** One destination parsed off a link's parentheses or a definition's tail: the target as written, and the span its token covers. */
interface ParsedDestination {
  /** The destination exactly as written, angle brackets excluded. */
  readonly text: string;
  /** Where the whole destination token starts and ends, relative to the text parsed. */
  readonly start: number;
  readonly end: number;
}

/**
 * Parses one link destination off the inside of a link's parentheses or a
 * definition's tail. The strict shapes first: an angle-bracket
 * destination (`<…>`, backslash escapes skipped) or a bare one — no
 * whitespace — then optional whitespace, an optional `"…"`, `'…'` or
 * `(…)` title, and nothing else. What does not parse that way stands as
 * the whole text the way the scanner has always read it — a bare target
 * holding a space, or a malformed title — so the link stays a link:
 * resolved as written, a broken one named, never silently dropped.
 */
function parseDestination(inside: string): ParsedDestination {
  let at = 0;
  while (at < inside.length && (inside[at] === ' ' || inside[at] === '\t')) at++;
  let text: string;
  let start = at;
  let end: number;
  let strict = true;
  if (inside[at] === '<') {
    let close = at + 1;
    while (close < inside.length && inside[close] !== '>') {
      if (inside[close] === '\\') close++;
      close++;
    }
    if (close >= inside.length) strict = false;
    else {
      text = inside.slice(at + 1, close);
      end = close + 1;
      at = close + 1;
    }
  } else {
    let bare = at;
    while (bare < inside.length && inside[bare] !== ' ' && inside[bare] !== '\t') {
      if (inside[bare] === '\\') bare++;
      bare++;
    }
    text = inside.slice(at, bare);
    end = bare;
    at = bare;
  }
  if (strict) {
    while (at < inside.length && (inside[at] === ' ' || inside[at] === '\t')) at++;
    if (at < inside.length) {
      const closer = inside[at] === '"' ? '"' : inside[at] === "'" ? "'" : inside[at] === '(' ? ')' : undefined;
      if (closer === undefined) strict = false;
      else {
        let title = at + 1;
        while (title < inside.length && inside[title] !== closer) {
          if (inside[title] === '\\') title++;
          title++;
        }
        if (title >= inside.length) strict = false;
        else {
          at = title + 1;
          while (at < inside.length && (inside[at] === ' ' || inside[at] === '\t')) at++;
          if (at !== inside.length) strict = false;
        }
      }
    }
  }
  if (!strict) return { text: inside, start: 0, end: inside.length };
  return { text: text!, start, end: end! };
}

/**
 * Finds one line's inline links and images outside code spans:
 * `[text](target)`, `![alt](target)`, with a title after the target, an
 * angle-bracket target, balanced brackets and parentheses, backslash
 * escapes skipped, and a code span — a backtick run and its matching run
 * — passed over entirely, recorded as a code region. Each found target's
 * exact span — the destination token whole, brackets included — is
 * recorded, with the 1-based line it sits on.
 */
function scanLineLinks(line: string, lineStart: number, links: ScannedLink[], code: ScannedCode[], lineNumber: number): void {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '`') {
      let run = 0;
      while (line[i + run] === '`') run++;
      // Skip past the matching run; an unmatched span runs to the line's end.
      let j = i + run;
      while (j < line.length) {
        if (line[j] !== '`') {
          j++;
          continue;
        }
        let close = 0;
        while (line[j + close] === '`') close++;
        j += close;
        if (close === run) break;
      }
      // The span's whole extent is code: recorded so the writers escape
      // markup around it, never inside it.
      code.push({ start: lineStart + i, end: lineStart + j });
      i = j;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    const image = ch === '!' && line[i + 1] === '[';
    if (ch !== '[' && !image) {
      i++;
      continue;
    }
    const bracket = image ? i + 1 : i;
    let depth = 1;
    let j = bracket + 1;
    while (j < line.length && depth > 0) {
      if (line[j] === '\\') {
        j += 2;
        continue;
      }
      if (line[j] === '[') depth++;
      else if (line[j] === ']') depth--;
      j++;
    }
    if (depth !== 0 || line[j] !== '(') {
      i = image ? i + 2 : i + 1;
      continue;
    }
    let parens = 1;
    let k = j + 1;
    while (k < line.length && parens > 0) {
      if (line[k] === '\\') {
        k += 2;
        continue;
      }
      if (line[k] === '(') parens++;
      else if (line[k] === ')') parens--;
      k++;
    }
    if (parens !== 0) {
      i++;
      continue;
    }
    // k stands one past the closing parenthesis; what stands inside is
    // the destination the link names, spelled as its document wrote it.
    const destination = parseDestination(line.slice(j + 1, k - 1));
    links.push({
      written: destination.text,
      start: lineStart + j + 1 + destination.start,
      end: lineStart + j + 1 + destination.end,
      line: lineNumber,
    });
    i = k;
  }
}

/** The document's own headings, plus the title line the writers insert when it has none. */
export function documentHeadings(page: WikiDocumentPage): readonly string[] {
  const headings = scanDocument(page.body).headings.map((heading) => heading.text);
  return page.insertTitle ? [page.title, ...headings] : headings;
}

/**
 * The document set's images: the files the build must copy into the site,
 * each once, sorted by code point.
 */
export function documentImages(documents: readonly WikiDocumentPage[]): readonly string[] {
  const images = new Set<string>();
  for (const page of documents) {
    for (const link of page.links) {
      if (link.kind === 'image') images.add(link.filePath!);
    }
  }
  return [...images].sort(byCodePoint);
}

/**
 * The repository's document pages: `README.md`, every `.md` under `docs/`,
 * and `madarch/review.md` when there is one, sorted by repository path.
 * Reads every document, resolves every link; when any link is broken, throws
 * `DocumentLinkError` naming all of them. A document that cannot be read is
 * refused on its own, naming the full path.
 */
export function documentPages(repo: string): readonly WikiDocumentPage[] {
  const paths = documentPaths(repo);
  const documentSet = new Set(paths);
  const broken: BrokenDocumentLink[] = [];
  const pages: WikiDocumentPage[] = [];
  for (const path of paths) {
    realPathInRepo(repo, path, 'document');
    let body: string;
    try {
      body = readFileSync(joinPath(repo, path), 'utf8');
    } catch (error) {
      throw new Error(`the document ${joinPath(repo, path)} cannot be read: ${(error as Error).message}`);
    }
    const scan = scanDocument(body);
    const links: WikiDocumentLink[] = [];
    for (const occurrence of scan.links) {
      const link = resolveLink(repo, path, occurrence.written, documentSet, broken, occurrence.line);
      if (link !== undefined) links.push(link);
    }
    const first = scan.headings[0];
    pages.push({
      id: `document/${path.slice(0, -'.md'.length)}`,
      // A document without any heading is titled by its file name, and says
      // so: the writers put the title line above the body.
      title: first !== undefined ? first.text : basename(path, '.md'),
      nav: ['Documents', ...dirOf(path).split('/').filter((segment) => segment !== '.')],
      body,
      blocks: [],
      insertTitle: first === undefined,
      links,
    });
  }
  // The images the pages reference, under the same rule: a symlinked image
  // out of the repository would be copied into the site.
  for (const image of documentImages(pages)) realPathInRepo(repo, image, 'image');
  if (broken.length > 0) {
    broken.sort((a, b) => byCodePoint(a.source, b.source) || a.line - b.line || byCodePoint(a.written, b.written) || byCodePoint(a.target, b.target));
    throw new DocumentLinkError(broken);
  }
  return pages;
}

/**
 * The repository's document paths, with the `.md`: `README.md` and
 * `madarch/review.md` when they exist as files, and every `.md` file under
 * `docs/` — sorted by code point, so the same repository gives the same
 * order wherever the file system lists them differently.
 */
function documentPaths(repo: string): readonly string[] {
  const paths: string[] = [];
  for (const candidate of ['README.md', 'madarch/review.md']) {
    if (isFile(joinPath(repo, candidate))) paths.push(candidate);
  }
  markdownUnder(joinPath(repo, 'docs'), 'docs', paths);
  paths.sort(byCodePoint);
  return paths;
}

/** Every `.md` file under `folder`, as a path relative to it, into `into`. */
function markdownUnder(folder: string, prefix: string, into: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`the documents folder ${folder} cannot be read: ${(error as Error).message}`);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      markdownUnder(joinPath(folder, entry.name), prefix === '' ? entry.name : `${prefix}/${entry.name}`, into);
      continue;
    }
    // A symlinked document counts too: stat follows the link, so a link
    // to a real document is found; the containment check refuses the one
    // whose real path leaves the repository. A link to a folder is not a
    // document and is not followed.
    if (entry.name.endsWith('.md') && isFile(joinPath(folder, entry.name))) {
      into.push(prefix === '' ? entry.name : `${prefix}/${entry.name}`);
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The repository file's real path, refused when it leaves the repository:
 * a symlink out of the repository would make the wiki read — and the site
 * publish — a file the repository does not hold. The repository's own path
 * is resolved the same way, so a repository reached through a symlinked
 * folder still holds its own files, and a symlink whose real path is
 * inside the repository is followed.
 */
function realPathInRepo(repo: string, path: string, what: 'document' | 'image'): string {
  const repoReal = realpathSync(repo);
  let real: string;
  try {
    real = realpathSync(joinPath(repo, path));
  } catch (error) {
    throw new Error(`the ${what} ${joinPath(repo, path)} cannot be read: ${(error as Error).message}`);
  }
  const into = relative(repoReal, real);
  if (into !== '' && (into.startsWith('..') || isAbsolute(into))) {
    throw new Error(
      `the ${what} ${joinPath(repo, path)} is a symlink to ${real}, outside the repository: the wiki refuses a ` +
        `repository file that leaves the repository; make it a real file of the repository, or point the symlink at a file inside it`,
    );
  }
  return real;
}

/**
 * What one written link target names, from the document that carries it.
 * Kept: empty and `#anchor` targets, scheme links and protocol-relative
 * ones — the built-site link check judges those in the built site. A
 * root-relative target names a repository path from the root
 * (`/docs/guide.md`), any other target a path from the document's own
 * folder. A `.md` target inside the document set is a page; a missing one
 * is broken, and so is any other file a browser could not show — an image
 * anywhere inside the repository is copied and linked, a target that
 * walks out of the repository (`../…`) is broken, never followed. Every
 * broken link is recorded in `broken`, with the 1-based line it sits on,
 * and nothing is returned for it.
 */
function resolveLink(repo: string, source: string, written: string, documents: ReadonlySet<string>, broken: BrokenDocumentLink[], line: number): WikiDocumentLink | undefined {
  const trimmed = written.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return { written, kind: 'keep' };
  }
  const hash = trimmed.indexOf('#');
  const anchor = hash < 0 ? undefined : trimmed.slice(hash + 1);
  const raw = (hash < 0 ? trimmed : trimmed.slice(0, hash)).split('?')[0]!;
  const target = normalize(trimmed.startsWith('/') ? raw.slice(1) : joinPath(dirOf(source), raw));
  if (target.endsWith('.md')) {
    if (documents.has(target)) {
      const pageId = `document/${target.slice(0, -'.md'.length)}`;
      return anchor === undefined ? { written, kind: 'page', pageId } : { written, kind: 'page', pageId, anchor };
    }
    broken.push({ source, written, target, line });
    return undefined;
  }
  if (IMAGE_EXTENSION.test(target) && !target.startsWith('..') && !isAbsolute(target)) {
    if (existsSync(joinPath(repo, target))) return { written, kind: 'image', filePath: target };
    broken.push({ source, written, target, line });
    return undefined;
  }
  broken.push({ source, written, target, line });
  return undefined;
}

