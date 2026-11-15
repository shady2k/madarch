/**
 * The one Markdown-to-HTML path of the app (decision 0036, section 7; madarch-u3vw.16): raw HTML is dropped — a raw block
 * in the product's own text is markup the page did not promise to draw — and a link or an image keeps only an http(s),
 * mailto or relative address. A `javascript:` address (however it is spelled in the target) is drawn as its text, never
 * as a link, so nothing in a repository's Markdown runs in the wiki's origin.
 *
 * Every reader of Markdown text goes through `renderMarkdown`; nothing else in the app parses Markdown.
 */
import { Marked, type Tokens } from 'marked';

/** The characters a scheme is made of, per RFC 3986: a letter, then letters, digits, `+`, `-` or `.`. */
const SCHEME_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789+.-';

/**
 * The scheme an address opens with, read character by character rather than by a pattern: the letters before its first
 * colon, when they are a scheme at all. An address with no colon before a `/`, `?` or `#` is relative.
 */
function schemeOf(address: string): string | undefined {
  if (address === '') return undefined;
  const first = address[0]!;
  if (!(first >= 'a' && first <= 'z') && !(first >= 'A' && first <= 'Z')) return undefined;
  for (const [at, character] of [...address].entries()) {
    if (character === ':') return at < 2 ? undefined : address.slice(0, at).toLowerCase();
    if (!SCHEME_CHARACTERS.includes(character.toLowerCase())) return undefined;
  }
  return undefined;
}

/** The address a link or an image may keep: http, https, mailto, or a relative one. */
export function safeHref(href: string): string | undefined {
  const held = href.trim();
  if (held === '') return undefined;
  const scheme = schemeOf(held);
  // A relative address: a path, a fragment or a query. It is resolved against the page's own origin.
  if (scheme === undefined) return held;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? held : undefined;
}

/** The characters an HTML text escapes, each for what it means in markup. */
const ESCAPES: readonly (readonly [string, string])[] = [['&', '&amp;'], ['"', '&quot;'], ['<', '&lt;'], ['>', '&gt;']];

/** The text with every character markup would read replaced: no pattern decides it, one table of escapes does. */
function escaped(value: string, escapes: readonly (readonly [string, string])[]): string {
  let out = '';
  for (const character of value) {
    const held = escapes.find(([from]) => from === character);
    out += held === undefined ? character : held[1];
  }
  return out;
}

/** The text of an attribute, escaped: an address is a reader's text, never markup. */
function attribute(value: string): string {
  return escaped(value, ESCAPES);
}

/** The text of a Markdown run, escaped: a character written as text is drawn as text. */
function text(value: string): string {
  return escaped(value, ESCAPES.filter(([from]) => from !== '"'));
}

/** The one parser: raw HTML dropped, and links and images held to the addresses a page may reach. */
const parser = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: () => '',
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link): string {
      const href = safeHref(token.href);
      const label = this.parser.parseInline(token.tokens);
      if (href === undefined) return label;
      const title = token.title === null || token.title === undefined ? '' : ` title="${attribute(token.title)}"`;
      const external = href.toLowerCase().startsWith('http:') || href.toLowerCase().startsWith('https:');
      return `<a href="${attribute(href)}"${title}${external ? ' rel="noreferrer"' : ''}>${label}</a>`;
    },
    image(token: Tokens.Image): string {
      const src = safeHref(token.href);
      const alt = attribute(token.text ?? '');
      if (src === undefined) return text(token.text ?? '');
      const title = token.title === null || token.title === undefined ? '' : ` title="${attribute(token.title)}"`;
      return `<img src="${attribute(src)}" alt="${alt}"${title}>`;
    },
  },
});

/** The HTML of one Markdown source: the only Markdown a page draws. */
export function renderMarkdown(source: string): string {
  return parser.parse(source, { async: false });
}
