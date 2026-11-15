/**
 * The one Markdown-to-HTML path of the app (decision 0036, section 7; madarch-u3vw.16): raw HTML is dropped — a raw block
 * in the product's own text is markup the page did not promise to draw — and a link or an image keeps only an http(s),
 * mailto or relative address. A `javascript:` address (however it is spelled in the target) is drawn as its text, never
 * as a link, so nothing in a repository's Markdown runs in the wiki's origin.
 *
 * Every reader of Markdown text goes through `renderMarkdown`; nothing else in the app parses Markdown.
 */
import { Marked, type Tokens } from 'marked';

/** The address a link or an image may keep: http, https, mailto, or a relative one. */
export function safeHref(href: string): string | undefined {
  const held = href.trim();
  if (held === '') return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(held);
  if (scheme === null) {
    // A relative address: a path, a fragment or a query. It is resolved against the page's own origin.
    return held;
  }
  const name = scheme[1]!.toLowerCase();
  return name === 'http' || name === 'https' || name === 'mailto' ? held : undefined;
}

/** The text of an attribute, escaped: an address is a reader's text, never markup. */
function attribute(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** The text of a Markdown run, escaped: a character written as text is drawn as text. */
function text(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
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
      const external = /^https?:/iu.test(href);
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
