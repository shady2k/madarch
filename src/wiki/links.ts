/**
 * The wiki's link check (docs/changes/wiki/capabilities/wiki.md, requirement
 * `links`): after the engine has built the site, every link inside it must
 * open a page, an asset or an anchor that exists. `readSiteFiles` hands the
 * checker a site folder as files and their text; `brokenLinks` is a pure
 * function from those files to every broken internal link, each naming the
 * page (site-relative) and the link as written, all of them, sorted by code
 * point. It reads no engine's name and no clock, so the same site always
 * gives the same report, and neither function knows Zensical: the Starlight
 * writer reuses both.
 *
 * Outside the check: a link that names a scheme — another site (`https://`),
 * `mailto:`, `tel:`, `javascript:`, `data:` — cannot name a file of the
 * site; a scheme-less `//host/…` link is another site too; and the engine's
 * own `404.html` is exempt, because it is served for every missing address,
 * so the page its relative links resolve from is arbitrary. Everything else
 * — relative, root-relative, with or without `#anchor`, `href` as well as
 * the `src` of scripts, styles and images — is checked against the built
 * files and the anchor ids in them.
 */
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join as joinPath, normalize } from 'node:path';
import { byCodePoint } from './pages.js';

/** Attributes whose value names something the reader's browser fetches. */
const LINK_ATTRIBUTE: Record<string, true> = { href: true, src: true };

/**
 * Elements whose content is raw text by HTML's own rules: a link-looking
 * string inside them is program or style text, not a link of the page.
 */
const RAW_TEXT_TAG: Record<string, true> = { script: true, style: true, textarea: true, title: true };

/** One broken link: the page that carries it, the link as written, and what it misses. */
export interface BrokenLink {
  /** The page carrying the link, as a path relative to the site folder. */
  readonly page: string;
  /** The link exactly as the page wrote it. */
  readonly link: string;
  /** What the link misses: the file that is not in the site, or the anchor that is not in its target. */
  readonly problem: string;
}

/** The links and the anchor ids one HTML page's text carries. */
interface HtmlRefs {
  readonly links: readonly string[];
  readonly ids: readonly string[];
}

/**
 * Walks one page's HTML and collects every `href`/`src` value and every
 * `id`, through a small tag scanner: comments, raw-text elements and quoted
 * values are skipped the way a browser reads them, so a link in a script's
 * text is not a link of the page, and a `>` inside a quoted value does not
 * end the tag. Attribute and tag names are matched case-insensitively; the
 * values are kept exactly as written.
 */
function scanHtml(text: string): HtmlRefs {
  const lower = text.toLowerCase();
  const links: string[] = [];
  const ids: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.charCodeAt(i) !== 60 /* < */) {
      i++;
      continue;
    }
    const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(text.slice(i + 1, i + 128))?.[0]?.toLowerCase();
    if (name === undefined) {
      i++;
      continue;
    }
    let j = i + 1 + name.length;
    while (j < n) {
      while (j < n && /[\s/]/.test(text[j]!)) j++;
      if (j >= n || text[j] === '>') {
        j++;
        break;
      }
      const attrStart = j;
      while (j < n && !/[\s=/>]/.test(text[j]!)) j++;
      const attr = text.slice(attrStart, j).toLowerCase();
      while (j < n && /\s/.test(text[j]!)) j++;
      let value = '';
      if (text[j] === '=') {
        j++;
        while (j < n && /\s/.test(text[j]!)) j++;
        const quote = text[j];
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, j + 1);
          value = text.slice(j + 1, close < 0 ? n : close);
          j = close < 0 ? n : close + 1;
        } else {
          const valueStart = j;
          while (j < n && !/[\s>]/.test(text[j]!)) j++;
          value = text.slice(valueStart, j);
        }
      }
      if (LINK_ATTRIBUTE[attr] !== undefined && value !== '') links.push(value);
      else if (attr === 'id' && value !== '') ids.push(value);
    }
    if (RAW_TEXT_TAG[name] !== undefined) {
      const close = lower.indexOf(`</${name}`, j);
      i = close < 0 ? n : close;
    } else {
      i = j;
    }
  }
  return { links, ids };
}

/**
 * Percent-decodes a link's path or anchor; a value that is not valid
 * percent-encoding is compared as written.
 */
function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The named character references a link's value can carry and still be
 * read as itself: the spec's names for ASCII punctuation — the characters
 * a scheme or a path separator could hide — and the common prose ones.
 * A name outside the table stands as written, judged literally, as the
 * checker has always judged it.
 */
const NAMED_ENTITY: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  excl: '!', num: '#', dollar: '$', percnt: '%', lpar: '(', rpar: ')', ast: '*', midast: '*', plus: '+', comma: ',',
  period: '.', sol: '/', colon: ':', semi: ';', equals: '=', quest: '?', commat: '@', lbrack: '[', bsol: '\\',
  rbrack: ']', Hat: '^', lowbar: '_', UnderBar: '_', grave: '`', DiacriticalGrave: '`', lbrace: '{', lcub: '{',
  rbrace: '}', rcub: '}', verbar: '|', vert: '|', VerticalLine: '|', NewLine: '\n', Tab: '\t',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', laquo: '«', raquo: '»', times: '×', divide: '÷', plusmn: '±', deg: '°', middot: '·', sect: '§',
  para: '¶', bull: '•', dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', euro: '€', pound: '£',
  yen: '¥', cent: '¢', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
};

/**
 * The value of a `href`/`src` as the reader's browser reads it: every
 * character reference — named, `&#decimal;` or `&#xhex;` — replaced by
 * its character, a reference no rule decodes standing as written, and a
 * reference resolving to a surrogate or beyond Unicode's range standing
 * as written too. The percent-decoding of paths and anchors happens
 * after this, the way a browser reads an attribute before its URL.
 */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code >= 0x110000 || (code >= 0xd800 && code < 0xe000) ? whole : String.fromCodePoint(code);
    }
    return NAMED_ENTITY[body] ?? whole;
  });
}

/**
 * What `written` on `page` misses, if anything, judged as the reader's
 * browser reads the attribute value: character references decoded first,
 * then the path and anchor percent-decoded. A file that is not among the
 * site's files (a directory link lands on its `index.html`), or an anchor
 * that is not an id of the file it lands on, is the miss; a link without
 * a path is a self-reference and lands on the page itself. The report
 * names the link as written, the way the page's HTML spells it.
 */
function linkProblem(
  files: ReadonlyMap<string, string>,
  idsOf: (file: string) => ReadonlySet<string>,
  page: string,
  written: string,
): BrokenLink | undefined {
  // The attribute value as the browser reads it: character references
  // decoded, the tabs and line breaks a URL parser strips gone — an
  // entity-encoded scheme is the scheme it spells, never a relative
  // path of `&`-prefixed files.
  const link = decodeEntities(written).replace(/[\t\n\r]/g, '');
  if (link === '' || link.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link)) return undefined;
  const hash = link.indexOf('#');
  const anchor = hash < 0 ? '' : decodePercent(link.slice(hash + 1));
  const raw = (hash < 0 ? link : link.slice(0, hash)).split('?')[0]!;
  if (raw === '') {
    return anchor !== '' && !idsOf(page).has(anchor) ? { page, link: written, problem: `no anchor "${anchor}" in "${page}"` } : undefined;
  }
  const hadSlash = raw.endsWith('/');
  const path = decodePercent(raw);
  const file = normalize(path.startsWith('/') ? path.slice(1) : joinPath(dirname(page), path)).replace(/\/+$/, '');
  const name = file === '' || file === '.' ? 'index.html' : file;
  const first = name === 'index.html' ? name : hadSlash ? `${name}/index.html` : name;
  let target: string | undefined;
  if (files.has(first)) target = first;
  else if (!hadSlash && files.has(`${name}/index.html`)) target = `${name}/index.html`;
  if (target === undefined) return { page, link: written, problem: `no file "${first}" in the site` };
  if (anchor !== '' && !idsOf(target).has(anchor)) return { page, link: written, problem: `no anchor "${anchor}" in "${target}"` };
  return undefined;
}

/**
 * Every broken internal link of the site, each once, sorted by code point
 * of page, link and problem — never just the first. Only `.html` pages are
 * read for links; every file of the site is a candidate target. The
 * engine's own `404.html` at the site root is exempt.
 */
export function brokenLinks(files: ReadonlyMap<string, string>): readonly BrokenLink[] {
  const idsByFile = new Map<string, ReadonlySet<string>>();
  const idsOf = (file: string): ReadonlySet<string> => {
    const cached = idsByFile.get(file);
    if (cached !== undefined) return cached;
    const ids = new Set(scanHtml(files.get(file) ?? '').ids);
    idsByFile.set(file, ids);
    return ids;
  };
  const broken: BrokenLink[] = [];
  const seen = new Set<string>();
  for (const [page, text] of files) {
    if (!page.endsWith('.html') || page === '404.html') continue;
    for (const link of scanHtml(text).links) {
      const found = linkProblem(files, idsOf, page, link);
      if (found === undefined) continue;
      const key = `${found.page}\u0000${found.link}\u0000${found.problem}`;
      if (seen.has(key)) continue;
      seen.add(key);
      broken.push(found);
    }
  }
  broken.sort((a, b) => byCodePoint(a.page, b.page) || byCodePoint(a.link, b.link) || byCodePoint(a.problem, b.problem));
  return broken;
}

/**
 * Reads a built site folder into the checker's input: every file, keyed by
 * its site-relative path, its text. Refuses with the path when the folder
 * or a file inside cannot be read — a missing input is never a silent pass.
 */
export function readSiteFiles(siteFolder: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (folder: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      throw new Error(`the built site cannot be read at ${folder}: ${(error as Error).message}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(joinPath(folder, entry.name), prefix === '' ? entry.name : `${prefix}/${entry.name}`);
        continue;
      }
      const full = joinPath(folder, entry.name);
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch (error) {
        throw new Error(`the built site file cannot be read at ${full}: ${(error as Error).message}`);
      }
      files.set(prefix === '' ? entry.name : `${prefix}/${entry.name}`, text);
    }
  };
  walk(siteFolder, '');
  return files;
}
