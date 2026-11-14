/**
 * The reading primitives every page component is built from: headings, paragraphs, links and the prose box the graph's
 * Markdown is drawn in. Nothing here holds product data; a component passes what it was given.
 */
import type { ReactElement, ReactNode } from 'react';

export function Heading({ children, title }: { readonly children: ReactNode; readonly title?: string }): ReactElement {
  return <h1 className="text-title font-semibold tracking-tight" title={title}>{children}</h1>;
}

export function Subheading({ children }: { readonly children: ReactNode }): ReactElement {
  return <h2 className="text-h2 font-semibold">{children}</h2>;
}

export function Muted({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="text-small text-muted">{children}</p>;
}

export function Pre({ children }: { readonly children: ReactNode }): ReactElement {
  return <pre className="text-small text-secondary">{children}</pre>;
}

export function Link({ href, children, onOpen }: { readonly href: string; readonly children: ReactNode; readonly onOpen?: (path: string) => void }): ReactElement {
  return (
    <a
      className="text-ink underline decoration-line underline-offset-2 hover:text-secondary"
      href={href}
      onClick={(event) => {
        if (onOpen === undefined) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen(href);
      }}
    >
      {children}
    </a>
  );
}

/** The graph's Markdown, drawn as the reading column's prose: the stylesheet's `main` rules carry its typography. */
export function Prose({ html }: { readonly html: string }): ReactElement {
  return <div className="max-w-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
