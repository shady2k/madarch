/**
 * The Markdown of a page, rendered as formatted text. Links follow the rule of
 * requirement `pages`: a link to a page the wiki holds opens that page on the
 * client side; a link whose target the wiki does not hold is shown as its
 * text, so no reader lands on a page that cannot be shown; an external link
 * opens as it is written.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import { useContext, type ReactElement, type MouseEvent, type ReactNode } from 'react';
import { addressOfPage } from './routes.js';
import { resolveLink } from './link.js';
import { routeContext, navigateTo } from './hold.js';

/** A link to one page of the wiki, opened on the client side without a reload. */
export function PageLink(props: { path: string; children?: ReactNode }): ReactElement {
  const address = addressOfPage(props.path);
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

/** Renders one document, with the app's link rules applied to every link. */
export function Markdown(props: { text: string }): ReactElement {
  const components: Components = { a: WikiLink };
  return <ReactMarkdown components={components}>{props.text}</ReactMarkdown>;
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
  if (resolved.kind === 'external') {
    return (
      <a href={resolved.href} target="_blank" rel="noreferrer">
        {props.children}
      </a>
    );
  }
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
