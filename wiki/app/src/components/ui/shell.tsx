/** The app's frame: the one shell the template frontend fills. It holds no page and knows no product data. */
import type { ReactElement, ReactNode } from 'react';

export function ShellFrame({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="min-h-screen bg-page text-foreground">
      <header className="border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold">{title}</h1>
      </header>
      <main className="px-4 py-6">{children}</main>
    </div>
  );
}

/** What the frame says until the template frontend lands. */
export function ShellNote(): ReactElement {
  return <p className="text-sm text-muted-foreground">The page templates arrive with the template frontend.</p>;
}
