/** The app's frame: the top bar with the reader's controls, and the column the page is drawn in. */
import type { ReactElement, ReactNode } from 'react';

export function ShellFrame({ title, actions, children }: { readonly title: string; readonly actions?: ReactNode; readonly children: ReactNode }): ReactElement {
  return (
    <div className="min-h-screen bg-ground text-ink">
      <header className="border-b border-line bg-chrome">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
          <h1 className="text-lg font-semibold">{title}</h1>
          {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6">{children}</main>
    </div>
  );
}
