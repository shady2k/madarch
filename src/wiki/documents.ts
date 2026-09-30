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
  /** Where the occurrence's opening bracket sits — the `[` of a link or a definition, the `[` of an image's `![`: the character the rewriter escapes to show a refused link as text. */
  readonly bracket: number;
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

/** What one document's Markdown holds: its headings, its links, its Mermaid fences, every code region, and the autolinks the wiki keeps. */
export interface DocumentScan {
  readonly headings: readonly ScannedHeading[];
  readonly links: readonly ScannedLink[];
  readonly mermaid: readonly ScannedMermaid[];
  /** Inline code spans and fenced blocks, any language: the regions whose `<` is code, never markup. */
  readonly code: readonly ScannedCode[];
  /** The kept autolinks: the regions whose `<` opens one, never markup to escape. */
  readonly autolinks: readonly ScannedAutolink[];
  /** Refused links whose label wraps over lines, so the per-line scan never pairs them: the build warns about each, at the line the link starts on. */
  readonly refusedWrapped: readonly ScannedWrappedLink[];
}

/** One code region of the body — a code span or a fence — its whole extent. */
export interface ScannedCode {
  /** Where the code starts: the first backtick, or the fence's opening line. */
  readonly start: number;
  /** Where it ends: past the closing run or the fence's last line. */
  readonly end: number;
}

/** One autolink the wiki keeps — `<https://example.com>`, `<mailto:a@b.c>`, `<a@b.c>` — its whole extent, the `<` and `>` included. */
export interface ScannedAutolink {
  /** Where the autolink starts: its `<`. */
  readonly start: number;
  /** Where it ends: past its `>`. */
  readonly end: number;
}

/** One refused link whose label wraps over lines: the destination as written, and the 1-based line the link starts on. */
export interface ScannedWrappedLink {
  readonly written: string;
  readonly line: number;
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
 * each document by its full path — the repository's own path joined with
 * the document's repository path — and the target it misses, sorted by
 * code point.
 */
export class DocumentLinkError extends Error {
  readonly broken: readonly BrokenDocumentLink[];

  constructor(broken: readonly BrokenDocumentLink[], repo: string) {
    super(
      [
        'the documents carry broken links:',
        ...broken.map(
          (link) =>
            `${joinPath(repo, link.source)}:${link.line}: links to "${link.written}" — ${link.target} is not a page of this wiki; fix the link or add the document`,
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
  const autolinks: ScannedAutolink[] = [];
  const refusedWrapped: ScannedWrappedLink[] = [];
  const lines = body.split('\n');
  let offset = 0;
  // A label still open at a line's end — its unclosed `[` count and the
  // line the link starts on — carried into the lines below, where its
  // `](` may stand. Every block boundary ends a paragraph the way the
  // engines read one, so the carry dies there: a blank line, a fence, a
  // heading, a definition.
  let carry: { depth: number; line: number } | undefined;
  let fence: { char: string; length: number; mermaid: boolean; contentStart: number; fenceStart: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (trimmed === '') carry = undefined;
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
      carry = undefined;
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/);
    if (heading !== null) {
      const text = (heading[2] ?? '').replace(/\s+#+\s*$/, '').trim();
      if (text !== '') headings.push({ level: heading[1]!.length, text });
      carry = undefined;
      continue;
    }
    const definition = line.match(/^ {0,3}\[([^\]]+)\]:[ \t]*/);
    if (definition !== null) {
      carry = undefined;
      // A link reference definition: its destination is the link the
      // engines render every `[text][label]` use from, so it is recorded
      // like an occurrence of its own, resolved and rewritten there.
      const rest = line.slice(definition[0].length);
      const destination = parseDestination(rest);
      if (destination.text.trim() !== '') {
        const base = start + definition[0].length;
        links.push({ written: destination.text, start: base + destination.start, end: base + destination.end, line: lineNumber, bracket: start + definition[0].indexOf('[') });
        continue;
      }
      // The destination may stand on the next line, an optional title
      // after it — one line ending between the parts, as the engines
      // read a definition. Recorded like any definition, at the line the
      // definition starts on, and only when that line is a destination
      // whole: never a list item or another block a bare `[label]:`
      // happens to sit above.
      const next = lines[index + 1];
      if (next !== undefined) {
        const split = parseDestination(next);
        if (split.complete && split.text.trim() !== '') {
          links.push({ written: split.text, start: offset + split.start, end: offset + split.end, line: lineNumber, bracket: start + definition[0].indexOf('[') });
          continue;
        }
      }
    }
    carry = scanLineLinks(line, start, links, code, autolinks, lineNumber, carry, refusedWrapped);
  }
  // A fence never closed runs to the end of the body; its content is code
  // all the way.
  if (fence !== undefined) code.push({ start: fence.fenceStart, end: body.length });
  return { headings, links, mermaid, code, autolinks, refusedWrapped };
}

/** One destination parsed off a link's parentheses or a definition's tail: the target as written, and the span its token covers. */
interface ParsedDestination {
  /** The destination exactly as written, angle brackets excluded. */
  readonly text: string;
  /** Where the whole destination token starts and ends, relative to the text parsed. */
  readonly start: number;
  readonly end: number;
  /** Whether the destination — and any title after it — consumed the whole tail: a split definition's destination is read only when it does. */
  readonly complete: boolean;
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
  if (!strict) return { text: inside, start: 0, end: inside.length, complete: false };
  return { text: text!, start, end: end!, complete: true };
}

const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]*):([^ \t<>]*)>/;
const EMAIL_AUTOLINK = /^<[\w.+-]+@[\w-]+(?:\.[\w-]+)*>/;

/**
 * The length of the autolink at `at` when the wiki keeps its scheme —
 * http, https or mailto, or an email address — else none: the `<` of any
 * other scheme, `javascript:` among them, is markup to escape, and the
 * link it would open is shown as text.
 */
function keptAutolinkLength(line: string, at: number): number | undefined {
  const uri = AUTOLINK.exec(line.slice(at));
  if (uri !== null) return KEPT_SCHEME[uri[1]!.toLowerCase()] === true ? uri[0].length : undefined;
  const mail = EMAIL_AUTOLINK.exec(line.slice(at));
  return mail !== null ? mail[0].length : undefined;
}

/**
 * Finds one line's inline links and images outside code spans:
 * `[text](target)`, `![alt](target)`, with a title after the target, an
 * angle-bracket target, balanced brackets and parentheses, backslash
 * escapes skipped, and a code span — a backtick run and its matching run
 * — passed over entirely, recorded as a code region. An autolink the wiki
 * keeps — `<https://example.com>`, `<mailto:a@b.c>`, `<a@b.c>` — is
 * recorded whole as a region of its own; a `<` of any other shape is
 * left for the writers to escape. Each found target's exact span — the
 * destination token whole, brackets included — is recorded, with the
 * 1-based line it sits on.
 *
 * A label the line above left open is resumed through `carry` — its
 * unclosed `[` count and the line the link starts on — and a `](` at its
 * closing bracket names a wrapped link: refused schemes only are pushed
 * onto `refusedWrapped`, for the build's warning, at the line the link
 * starts on; the occurrence never enters `links`, so what the rewriter
 * writes and the closer backstop catches stay as they are. The line's
 * own label left open at its end is returned for the line below.
 */
function scanLineLinks(
  line: string,
  lineStart: number,
  links: ScannedLink[],
  code: ScannedCode[],
  autolinks: ScannedAutolink[],
  lineNumber: number,
  carry: { depth: number; line: number } | undefined,
  refusedWrapped: ScannedWrappedLink[],
): { depth: number; line: number } | undefined {
  let i = 0;
  let depth = carry?.depth ?? 0;
  let carriedLine = carry?.line ?? 0;
  let carrying = carry !== undefined;
  let open: { depth: number; line: number } | undefined;
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
    if (ch === '<') {
      const autolink = keptAutolinkLength(line, i);
      if (autolink !== undefined) {
        autolinks.push({ start: lineStart + i, end: lineStart + i + autolink });
        i += autolink;
        continue;
      }
      i++;
      continue;
    }
    if (carrying) {
      if (ch === '[') {
        depth++;
        i++;
        continue;
      }
      if (ch === ']') {
        depth--;
        if (depth > 0) {
          i++;
          continue;
        }
        carrying = false;
        if (line[i + 1] !== '(') {
          i++;
          continue;
        }
        let parens = 1;
        let k = i + 2;
        while (k < line.length && parens > 0) {
          if (line[k] === '\\') {
            k += 2;
            continue;
          }
          if (line[k] === '(') parens++;
          else if (line[k] === ')') parens--;
          k++;
        }
        if (parens === 0) {
          const destination = parseDestination(line.slice(i + 2, k - 1));
          if (isRefusedScheme(destination.text.trim())) refusedWrapped.push({ written: destination.text, line: carriedLine });
          i = k;
        } else {
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    const image = ch === '!' && line[i + 1] === '[';
    if (ch !== '[' && !image) {
      i++;
      continue;
    }
    const bracket = image ? i + 1 : i;
    let unclosed = 1;
    let j = bracket + 1;
    while (j < line.length && unclosed > 0) {
      if (line[j] === '\\') {
        j += 2;
        continue;
      }
      if (line[j] === '[') unclosed++;
      else if (line[j] === ']') unclosed--;
      j++;
    }
    if (unclosed !== 0 || line[j] !== '(') {
      // The label still stands open at the line's end: the link starts
      // here, its destination possibly standing on a line below. The
      // first scan that ends open is the outermost unclosed `[` — its
      // count is the one the next line resumes.
      if (unclosed !== 0 && open === undefined) open = { depth: unclosed, line: lineNumber };
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
      bracket: image ? lineStart + i + 1 : lineStart + i,
    });
    i = k;
  }
  return carrying ? { depth, line: carriedLine } : open;
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

/** One refused link of the documents: who wrote it, where, and what it wrote. */
export interface RefusedDocumentLink {
  /** The document carrying the link, as a repository path. */
  readonly source: string;
  /** The 1-based line the link sits on. */
  readonly line: number;
  /** The destination exactly as the document wrote it. */
  readonly written: string;
}

/**
 * The documents' refused links — destinations whose scheme the wiki does
 * not keep — one row each, sorted by code point: the build warns about
 * every one of them, and the page shows the link as text. A refused link
 * whose label wraps over lines stands among them too, named at the line
 * the link starts on, though the per-line scan could never pair it.
 */
export function refusedDocumentLinks(documents: readonly WikiDocumentPage[]): readonly RefusedDocumentLink[] {
  const rows = documents.flatMap((page) => [
    ...page.links.flatMap((link) => (link.kind === 'refused' ? [{ source: `${page.id.slice('document/'.length)}.md`, line: link.line!, written: link.written }] : [])),
    ...page.refusedWrapped.map((link) => ({ source: `${page.id.slice('document/'.length)}.md`, line: link.line, written: link.written })),
  ]);
  return rows.sort((a, b) => byCodePoint(a.source, b.source) || a.line - b.line || byCodePoint(a.written, b.written));
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
      refusedWrapped: scan.refusedWrapped,
    });
  }
  // The images the pages reference, under the same rule: a symlinked image
  // out of the repository would be copied into the site.
  for (const image of documentImages(pages)) realPathInRepo(repo, image, 'image');
  if (broken.length > 0) {
    broken.sort((a, b) => byCodePoint(a.source, b.source) || a.line - b.line || byCodePoint(a.written, b.written) || byCodePoint(a.target, b.target));
    throw new DocumentLinkError(broken, repo);
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

/** The schemes a document link may keep: the ones a reader's browser may be told to follow. */
const KEPT_SCHEME: Record<string, true> = { http: true, https: true, mailto: true };

/**
 * Whether a written destination names a scheme the wiki does not keep —
 * `javascript:`, `data:`, `vbscript:`, `file:`, any other, in any case,
 * with the leading whitespace a destination may carry. The wiki shows
 * such a link as text and the build warns: a repository has no business
 * running code in a reader's browser.
 */
export function isRefusedScheme(written: string): boolean {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(written.trim());
  return scheme !== null && KEPT_SCHEME[scheme[0]!.slice(0, -1).toLowerCase()] !== true;
}

/**
 * What one written link target names, from the document that carries it.
 * Kept: empty and `#anchor` targets, kept scheme links and
 * protocol-relative ones — the built-site link check judges those in the
 * built site. A link whose scheme the wiki does not keep is refused:
 * shown as text, warned about by the build naming document, line and
 * destination. A
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
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) return { written, kind: 'keep' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    // Only the schemes a reader's browser may follow are kept: every
    // other one is refused, the link shown as text, the build warning
    // about it naming the document, the line and the destination.
    return isRefusedScheme(trimmed) ? { written, kind: 'refused', line } : { written, kind: 'keep' };
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


/**
 * The `]` positions of a finished page body that must stop being link
 * closers: every `](` outside code regions and Mermaid blocks whose
 * destination names a scheme the wiki does not keep. The rewriter escapes
 * each into `\]`, so no engine can read a link — or an image — out of the
 * text: a label that cannot close never parses as a link, whoever wrote
 * its opening bracket, on the destination's line or a line above. An
 * escaped `]` shows as `]`, so a hit that was never a link changes
 * nothing a reader sees; code regions and Mermaid blocks are code and
 * diagram source, drawn as written, never links.
 */
export function refusedLinkClosers(body: string): readonly number[] {
  const closers: number[] = [];
  const code = scanDocument(body).code;
  const inCode = (position: number): boolean => code.some((span) => position >= span.start && position < span.end);
  for (let at = body.indexOf(']('); at >= 0; at = body.indexOf('](', at + 1)) {
    if (inCode(at) || inMermaidBlock(body, at)) continue;
    if (!isRefusedScheme(parseDestination(body.slice(at + 2)).text)) continue;
    closers.push(at);
  }
  return closers;
}

/** Whether `at` sits in a `<div class="mermaid">…</div>` block: diagram source the shipped runtime draws, never a link of the page. */
function inMermaidBlock(body: string, at: number): boolean {
  for (let open = body.indexOf('<div class="mermaid">'); open >= 0 && open < at; open = body.indexOf('<div class="mermaid">', open + 1)) {
    const close = body.indexOf('</div>', open);
    if (close >= 0 && at < close) return true;
  }
  return false;
}
