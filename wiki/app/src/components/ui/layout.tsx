/** The page's laying out: columns, stacks, and the section that holds a title and its component. */
import type { ReactElement, ReactNode } from 'react';
import { Subheading } from './typography.js';

export function PageColumn({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-6">{children}</div>;
}

export function Stack({ children, gap = 3 }: { readonly children: ReactNode; readonly gap?: number }): ReactElement {
  const space = { 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4' }[gap] ?? 'gap-3';
  return <div className={`flex flex-col ${space}`}>{children}</div>;
}

export function Inline({ children, gap = 2 }: { readonly children: ReactNode; readonly gap?: number }): ReactElement {
  const space = { 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4' }[gap] ?? 'gap-2';
  return <div className={`flex flex-wrap items-center ${space}`}>{children}</div>;
}

export function Section({ title, children }: { readonly title?: string; readonly children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      {title === undefined || title === '' ? null : <Subheading>{title}</Subheading>}
      {children}
    </section>
  );
}

/** A box that carries one tab's panel. */
export function Panel({ children, role }: { readonly children: ReactNode; readonly role?: string }): ReactElement {
  return <div role={role}>{children}</div>;
}

/** A caption or counter that stays on one line. */
export function InlineMuted({ children }: { readonly children: ReactNode }): ReactElement {
  return <span className="text-small text-muted">{children}</span>;
}
