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
 * Renders one document, with the app's link rules applied to every link.
 * The document stands inside a `.reading` element, the hook the reading
 * stylesheet scopes its rules to, and each table stands inside a
 * `.table-wrap` so a wide table scrolls in its own container, never the page.
 */
export function Markdown(props: { text: string }): ReactElement {
  const components: Components = {
    a: WikiLink,
    table: TableInWrap,
  };
  return (
    <div className="reading">
      {/* GFM so the pipe tables a product page holds render as tables. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{props.text}</ReactMarkdown>
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
