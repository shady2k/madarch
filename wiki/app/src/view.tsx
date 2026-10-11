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
import { resolveLink } from './link.js';
import { routeContext, navigateTo } from './hold.js';
import { byCodePoint } from './sort.js';
import { ARCHITECTURE_PREFIX } from './routes.js';

/** The client-side follow of one address, as the page links click. */
function followTo(address: string): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateTo(address);
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
    navigateTo(address);
  };
  return (
    <a href={address} className={props.className} aria-current={props.ariaCurrent} onClick={follow}>
      {props.children}
    </a>
  );
}

/**
 * The first standalone mention of each element id, wrapped as a link to
 * the element's page (feature E, madarch-iuc.15; the conservative rule the
 * backlinks use: the id, bounded by non-word characters — a name is never
 * matched, only the id as written). Fences, inline code spans and existing
 * links' own brackets are never rewritten.
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
    // Existing links' targets are masked so a target that names an element
    // is never wrapped a second time; the masks go back after the rewrite.
    const masks: string[] = [];
    const masked = part.replace(/\]\([^()\s]*\)/g, (whole) => {
      masks.push(whole);
      return `\u0000${masks.length - 1}\u0000`;
    });
    let result = masked;
    for (const id of [...pending].sort(byCodePoint)) {
      const pattern = new RegExp(`(^|[^\\w\`[])(${escapeRegExp(id)})(?=[^\\w-]|$)`);
      const found = pattern.exec(result);
      if (found === null) continue;
      const address = links.get(id)!;
      result = `${result.slice(0, found.index)}${found[1]}[${found[2]}](${address})${result.slice(found.index + found[0].length)}`;
      pending.delete(id);
    }
    return result.replace(/\u0000(\d+)\u0000/g, (whole, at: string) => masks[Number(at)] ?? whole);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    return <a href={props.href} onClick={followTo(props.href)}>{props.children}</a>;
  }
  const route = useContext(routeContext);
  const resolved = resolveLink(route.path ?? '', props.href, route.heldPaths);
  if (resolved.kind === 'plain') return <span className="plain-link">{props.children}</span>;
  const address = addressOfPage(resolved.path);
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateTo(address);
  };
  return (
    <a href={address} onClick={follow}>
      {props.children}
    </a>
  );
}
