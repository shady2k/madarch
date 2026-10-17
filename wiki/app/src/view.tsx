/**
 * The Markdown of a page, rendered as formatted text. Links follow the rule of
 * requirement `pages`: a link to a page the wiki holds opens that page on the
 * client side; a link to anything that is not a page of the wiki — an outside
 * address included — is shown as its text, so no reader lands on a page that
 * cannot be shown.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useContext, type ReactElement, type MouseEvent, type ReactNode } from 'react';
import { addressOfPage } from './routes.js';
import { appPath } from './app-base.js';
import { resolveLink } from './link.js';
import { routeContext, navigateTo } from './hold.js';
import { byCodePoint } from './sort.js';
import { ARCHITECTURE_PREFIX } from './routes.js';

/** The client-side follow of one address, as the page links click. */
function followTo(address: string): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateTo(appPath(address));
  };
}

/** A link to one page of the wiki, opened on the client side without a reload. */
/**
 * A link to one page of the wiki, opened on the client side without a reload.
 * A caller can pass an `aria-current` state and its own class on the link, as
 * the shell's navigation does for the open page.
 */
export function PageLink(props: {
  path: string;
  className?: string;
  ariaCurrent?: 'page' | true;
  children?: ReactNode;
}): ReactElement {
  const address = addressOfPage(props.path);
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateTo(appPath(address));
  };
  return (
    <a href={appPath(address)} className={props.className} aria-current={props.ariaCurrent} onClick={follow}>
      {props.children}
    </a>
  );
}

/**
 * The first standalone mention of each element id, wrapped as a link to
 * the element's page (feature E, madarch-iuc.15) — the same conservative
 * rule the server's named-by list follows (src/product-wiki/architecture.ts
 * textNamesElement), one rule on both sides: the id as written, a word
 * character or a hyphen on neither side, never inside a fence, a code span
 * or an existing link's target.
 */
export function linkElements(text: string, links: ReadonlyMap<string, string>): string {
  if (links.size === 0 || text === '') return text;
  const lines = text.split('\n');
  let fence: string | null = null;
  const pending = new Set(links.keys());
  const out = lines.map((line) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (mark !== null) {
      const run = mark[1]!;
      if (fence === null) fence = run[0]!;
      else if (fence === run[0] && line.trim() === run[0]!.repeat(run.length)) fence = null;
      return line;
    }
    if (fence !== null) return line;
    let result = '';
    let at = 0;
    while (at < line.length) {
      const tick = line.indexOf('`', at);
      if (tick < 0) break;
      const close = line.indexOf('`', tick + 1);
      const tail = close < 0 ? line.length : close + 1;
      result += rewrite(line.slice(at, tick)) + line.slice(tick, tail);
      at = tail;
    }
    return result + rewrite(line.slice(at));
  });
  return out.join('\n');

  /** The one part's plain text: the still-pending ids' first mentions wrapped. */
  function rewrite(part: string): string {
    if (pending.size === 0) return part;
    // Existing links' destinations are masked so a destination that names
    // an element — title included, the run counted to its closing paren —
    // is never wrapped a second time; the masks go back after the rewrite.
    // The same masking the server's named-by read applies.
    const masks: string[] = [];
    const masked = maskLinkDestinations(part, (whole) => {
      masks.push(whole);
      return `\u0000${masks.length - 1}\u0000`;
    });
    let result = masked;
    for (const id of [...pending].sort(byCodePoint)) {
      // The boundary check is plain character comparison, not a regex
      // class: the id must not be preceded or followed by a word character,
      // a dot or a hyphen (both are part of an id), so `not-shop` never
      // names `shop` and `a.b` never names `b`.
      let at = result.indexOf(id);
      while (at >= 0) {
        const before = at === 0 ? '' : result[at - 1]!;
        const after = at + id.length >= result.length ? '' : result[at + id.length]!;
        if (!isIdChar(before) && !isIdChar(after)) {
          const address = links.get(id)!;
          result = `${result.slice(0, at)}[${id}](${address})${result.slice(at + id.length)}`;
          pending.delete(id);
          break;
        }
        at = result.indexOf(id, at + 1);
      }
    }
    return result.replace(/\u0000(\d+)\u0000/g, (whole, at: string) => masks[Number(at)] ?? whole);
  }
}

/** Whether the character keeps an id bound to a larger word: word characters, dots and hyphens do. */
function isIdChar(char: string): boolean {
  return char !== '' && /[\w.-]/.test(char);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Masks every link destination — `](` to its closing `)`, counted by depth
 * so a destination with a parenthesised or quoted title is masked whole —
 * handing each run to `mask` and splicing its return in its place. The
 * same masking the server's named-by read applies.
 */
function maskLinkDestinations(line: string, mask: (whole: string) => string): string {
  let masked = '';
  let at = 0;
  while (at < line.length) {
    const open = line.indexOf('](', at);
    if (open < 0) break;
    const from = open + 1;
    let depth = 0;
    let close = -1;
    for (let at2 = from; at2 < line.length; at2++) {
      if (line[at2] === '(') depth++;
      else if (line[at2] === ')') {
        depth--;
        if (depth === 0) {
          close = at2;
          break;
        }
      }
    }
    if (close < 0) break; // an unclosed link: nothing after it is masked
    masked += line.slice(at, from) + mask(line.slice(from, close + 1)) ;
    at = close + 1;
  }
  return masked + line.slice(at);
}

/**
 * Renders one document, with the app's link rules applied to every link.
 * The document stands inside a `.reading` element, the hook the reading
 * stylesheet scopes its rules to, and each table stands inside a
 * `.table-wrap` so a wide table scrolls in its own container, never the
 * page. `elementLinks`, when given, wraps the first standalone mention of
 * each named element id as a link to the element's page.
 */
export function Markdown(props: { text: string; elementLinks?: ReadonlyMap<string, string> }): ReactElement {
  const components: Components = {
    a: WikiLink,
    table: TableInWrap,
  };
  const text = props.elementLinks === undefined ? props.text : linkElements(props.text, props.elementLinks);
  return (
    <div className="reading">
      {/* GFM so the pipe tables a product page holds render as tables. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}

/** A Markdown table, wrapped so it scrolls in its own container. */
function TableInWrap(props: { children?: ReactNode }): ReactElement {
  return (
    <div className="table-wrap">
      <table>{props.children}</table>
    </div>
  );
}

function WikiLink(props: {
  href?: string;
  children?: ReactNode;
  node?: unknown;
}): ReactElement | null {
  if (props.href === undefined) return null;
  // The app's own Architecture addresses (feature E) answer by themselves:
  // they are not pages of the product, so the held-pages rule does not
  // judge them.
  if (props.href.startsWith(ARCHITECTURE_PREFIX)) {
    return <a href={appPath(props.href)} onClick={followTo(props.href)}>{props.children}</a>;
  }
  const route = useContext(routeContext);
  const resolved = resolveLink(route.path ?? '', props.href, route.heldPaths);
  if (resolved.kind === 'plain') return <span className="plain-link">{props.children}</span>;
  const address = addressOfPage(resolved.path);
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateTo(appPath(address));
  };
  return (
    <a href={appPath(address)} onClick={follow}>
      {props.children}
    </a>
  );
}
