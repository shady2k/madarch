/**
 * The repository's own documents as wiki pages (docs/changes/wiki/capabilities/wiki.md,
 * requirement `documents`): `README.md`, every Markdown file under `docs/`,
 * and the review report beside the model when there is one. Each document
 * becomes a `document/…` page whose body is the file's Markdown whole, with
 * a title where the document has none, and its links resolved — an inline
 * one, with its title or in angle brackets, a reference definition, a
 * root-relative one — to another document's page, to an image the build
 * copies into the site, to the full address of the path it names on the
 * repository's host at the commit the wiki is built from, or left as
 * written: an external scheme, a `#anchor` of the same page, a
 * protocol-relative link. Where there is no host to lead to — no origin,
 * a host the wiki does not link to, a path that climbs out of the
 * repository — and for a scheme the wiki refuses, the link is shown as
 * text; the build warns about each (requirement `links` stays for the
 * built site: every link within it must open).
 *
 * The scan a document page is built from is exported for the writers: they
 * walk the same links and Mermaid fences when they rewrite the body.
 */
import { byCodePoint, type WikiDocumentLink, type WikiDocumentPage } from './pages.js';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
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

/**
 * Where a document's outside links lead: the repository's HEAD commit —
 * the revision the rendering uses — and its origin remote's URL as git
 * spells it, when there is one. The build reads both off the repository
 * and passes them in; the tests pass them standing still.
 */
export interface DocumentHost {
  /** The repository's HEAD commit, spelled the way git spells it. */
  readonly commit: string;
  /** The origin remote's URL, when the repository has one. */
  readonly origin?: string;
}

/** The repository hosts the wiki can link a document's path to. */
const HOSTS: Record<string, 'github' | 'gitlab'> = { 'github.com': 'github', 'gitlab.com': 'gitlab' };

/**
 * The host, owner and repository an origin remote names, when the wiki
 * can link to it: an `https://` or `ssh://` URL or the `git@host:path`
 * form, on github.com or gitlab.com, the `.git` suffix dropped. Any other
 * spelling — another scheme (`http://`, `git://`, `file://`), an scp form
 * without the `git@` user or with another, another host, a local path —
 * is none.
 */
function originHost(origin: string): { kind: 'github' | 'gitlab'; owner: string; repo: string } | undefined {
  let host: string;
  let path: string;
  if (/^(?:https|ssh):\/\//i.test(origin)) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return undefined;
    }
    host = url.hostname.toLowerCase();
    path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } else {
    const scp = /^git@([^:/]+):(.+)$/.exec(origin);
    if (scp === null) return undefined;
    host = scp[1]!.toLowerCase();
    path = scp[2]!.replace(/\/+$/, '');
  }
  const kind = HOSTS[host];
  if (kind === undefined) return undefined;
  const segments = path.replace(/\.git$/, '').split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return undefined;
  return { kind, owner: segments.slice(0, -1).join('/'), repo: segments[segments.length - 1]! };
}

/**
 * The path `path` spells as URL path segments: each segment
 * percent-encoded (`encodeURIComponent`), `/` between the segments. The
 * characters a repository path or an owner can carry — space, `#`, `?`,
 * `%`, angle brackets, quotes, anything else — reach the URL as data and
 * can never leave it, end a Markdown destination or become markup; and a
 * `%2e%2e` a document wrote stays written, so no browser normalizes the
 * address out of the repository.
 */
function encodedSegments(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * The address of `path` on the repository's host at `commit`: a `blob`
 * for a file, a `tree` for a folder the repository holds, in the shape
 * the host spells — owner, repository, commit and every path segment
 * percent-encoded, the anchor joined on separately by the caller. An
 * origin the wiki does not link to gives none.
 */
function hostFileUrl(origin: string, commit: string, path: string, folder: boolean): string | undefined {
  const parsed = originHost(origin);
  if (parsed === undefined) return undefined;
  const kind = folder ? 'tree' : 'blob';
  const prefix =
    parsed.kind === 'github'
      ? `https://github.com/${encodedSegments(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${kind}/${encodeURIComponent(commit)}`
      : `https://gitlab.com/${encodedSegments(parsed.owner)}/${encodeURIComponent(parsed.repo)}/-/${kind}/${encodeURIComponent(commit)}`;
  return `${prefix}/${encodedSegments(path)}`;
}

/** The most a `git ls-tree` of one commit may come back as before the read is refused. */
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

/**
 * Every path the commit holds, with what it is there — a `blob` (a file)
 * or a `tree` (a folder) — from one `git ls-tree` of the whole commit.
 * The root is there too, as the empty path: `ls-tree` lists what the root
 * holds, never the root itself, and the commit always holds it as a tree.
 * The URL names the commit, so what the repository holds is judged
 * there, never in the mutable worktree: a committed folder deleted from
 * the worktree is still a tree, an untracked file is not in the
 * repository at all. Undefined when git cannot read the commit, so a
 * caller with no commit tree to read (no host, a folder that is not a
 * git repository) knows to judge the worktree instead.
 */
function treeAtCommit(repo: string, commit: string): ReadonlyMap<string, 'file' | 'folder'> | undefined {
  if (commit.trim() === '') return undefined;
  const run = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '-t', '-z', commit], { encoding: 'utf8', maxBuffer: MAX_GIT_BUFFER });
  if (run.error !== undefined || run.status !== 0) return undefined;
  const entries = new Map<string, 'file' | 'folder'>();
  for (const record of run.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const type = record.slice(0, tab).split(' ')[1];
    if (type === 'blob') entries.set(record.slice(tab + 1), 'file');
    if (type === 'tree') entries.set(record.slice(tab + 1), 'folder');
  }
  // `ls-tree -r -t` lists every entry under the root but never the root
  // itself; the commit always holds the root, and holds it as a tree.
  entries.set('', 'folder');
  return entries;
}


/** One document link the build warns about: who wrote it, where, as written, and why it is not a link. */
export interface DocumentLinkWarning {
  /** The document carrying the link, as a repository path. */
  readonly source: string;
  /** The 1-based line the link sits on. */
  readonly line: number;
  /** The link exactly as the document wrote it. */
  readonly written: string;
  /** The warning's reason clause, after the em dash. */
  readonly why: string;
}

/**
 * Every document link the build warns about, one row each, sorted by
 * document, line and target as written: every link shown as text — with
 * the reason it leads nowhere — and every host link the repository does
 * not hold. A host link the repository holds warns nothing.
 */
export function documentLinkWarnings(documents: readonly WikiDocumentPage[], host?: DocumentHost): readonly DocumentLinkWarning[] {
  const rows = documents.flatMap((page) =>
    page.links.flatMap((link) => {
      const source = `${page.id.slice('document/'.length)}.md`;
      if (link.kind === 'host') {
        return link.missing === true ? [{ source, line: link.line!, written: link.written, why: `${link.target} is not in the repository; linked to the host` }] : [];
      }
      if (link.kind !== 'text') return [];
      const why =
        link.reason === 'escapes-repository'
          ? `${link.target} climbs out of the repository; the link is shown as text`
          : link.reason === 'no-origin'
            ? `${link.target} is not a page of this wiki and the repository has no origin to link to; the link is shown as text`
            : `${link.target} is not a page of this wiki and the origin ${host?.origin} is not a host the wiki links to; the link is shown as text`;
      return [{ source, line: link.line!, written: link.written, why }];
    }),
  );
  return rows.sort((a, b) => byCodePoint(a.source, b.source) || a.line - b.line || byCodePoint(a.written, b.written));
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
      // A heading's links are links all the same: scanned like any line's,
      // resolved and rewritten where they stand. The heading still ends a
      // paragraph: a label left open here is not carried below.
      scanLineLinks(line, start, links, code, autolinks, lineNumber, undefined, refusedWrapped);
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
 * Reads every document and resolves every link against the host the build
 * passes in — the repository's HEAD commit and its origin remote, where
 * it has them. A document that cannot be read is refused on its own,
 * naming the full path; a link never refuses the build.
 */
export function documentPages(repo: string, host?: DocumentHost): readonly WikiDocumentPage[] {
  const paths = documentPaths(repo);
  const documentSet = new Set(paths);
  // What the built commit holds, read once: every link's target is judged
  // against this tree when it can be read, never against the worktree.
  const committed = host === undefined ? undefined : treeAtCommit(repo, host.commit);
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
      const link = resolveLink(repo, path, occurrence.written, documentSet, host, occurrence.line, committed);
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
 * folder. A target that resolves to the root itself — `..` from a
 * folder, `./` beside the root, `/` — is held as the tree the root is,
 * addressed with nothing after the commit. A `.md` target inside the
 * document set is a page. Every other
 * target leads to the repository's host at the commit the wiki is built
 * from — a file the built commit holds as a `blob`, a folder it holds as
 * a `tree`, a target it does not hold as a `blob` all the
 * same, named in a warning — and an image the repository holds is copied
 * and linked as before. Where there is no host to lead to — no origin,
 * a host the wiki does not link to, a path that climbs out of the
 * repository (`../…` past the root) — the link is shown as text, with
 * the line it sits on and the repository path it names.
 */
function resolveLink(repo: string, source: string, written: string, documents: ReadonlySet<string>, host: DocumentHost | undefined, line: number, committed: ReadonlyMap<string, 'file' | 'folder'> | undefined): WikiDocumentLink | undefined {
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
  // The path the reader's browser would see: the percent escapes read
  // (`%2e%2e` is `..` once decoded), so the containment check and the
  // commit judge the name the URL will carry, not the spelling; an
  // escape that does not parse stays as written.
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    path = raw;
  }
  const normalized = normalize(trimmed.startsWith('/') ? path.slice(1) : joinPath(dirOf(source), path));
  // The repository root normalizes to the current directory — `.` or
  // `./` (`normalize` keeps a trailing separator) — and its repository
  // path is the empty one: nothing after the commit in the host address.
  // A folder written with a trailing slash (`../decisions/`) is the
  // folder itself: the commit's tree names folders without one, so the
  // slash is judged away and the link spells the bare path.
  const target = (normalized === '.' || normalized === './' ? '' : normalized).replace(/\/+$/, '');
  if (target.endsWith('.md') && documents.has(target)) {
    const pageId = `document/${target.slice(0, -'.md'.length)}`;
    return anchor === undefined ? { written, kind: 'page', pageId } : { written, kind: 'page', pageId, anchor };
  }
  if (target.startsWith('..') || isAbsolute(target)) {
    return { written, kind: 'text', target, reason: 'escapes-repository', line };
  }
  let onDisk: 'missing' | 'file' | 'folder';
  try {
    const stat = statSync(joinPath(repo, target));
    onDisk = stat.isDirectory() ? 'folder' : 'file';
  } catch {
    onDisk = 'missing';
  }
  // An image the repository holds is copied into the site, as before; an
  // image it does not hold leads to the host like any other miss.
  if (IMAGE_EXTENSION.test(target) && onDisk === 'file') return { written, kind: 'image', filePath: target };
  if (host?.origin === undefined) return { written, kind: 'text', target, reason: 'no-origin', line };
  // The commit decides what the URL says is there — a blob or a tree,
  // held or not: the address names the commit, so the worktree's answer
  // (a folder deleted after the commit, an untracked file) is not the
  // repository's. Where the commit's tree cannot be read, the worktree
  // stands in, as before.
  const held = committed !== undefined ? (committed.get(target) ?? 'missing') : onDisk;
  const url = hostFileUrl(host.origin, host.commit, target, held === 'folder');
  if (url === undefined) return { written, kind: 'text', target, reason: 'unlinked-host', line };
  return {
    written,
    kind: 'host',
    url: anchor === undefined ? url : `${url}#${encodeURIComponent(anchor)}`,
    target,
    missing: held === 'missing',
    line,
  };
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
