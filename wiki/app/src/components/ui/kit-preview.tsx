/** Layout primitives for the kit's live component examples. */
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils.js';

type KitContentProps = { title: string; description?: string; children: ReactNode; className?: string };

export function KitPageLayout({ title, description, children, className }: KitContentProps) {
  return <main className={cn('mx-auto grid w-full max-w-[var(--measure)] gap-8 p-4 text-ink md:p-8', className)}>
    <header className="grid gap-3">
      <h1 className="m-0 text-title font-semibold leading-tight">{title}</h1>
      {description && <p className="m-0 max-w-prose text-body text-secondary">{description}</p>}
    </header>
    {children}
  </main>;
}

export function KitSection({ title, description, children, className }: KitContentProps) {
  const id = useId();
  return <section aria-labelledby={id} className={cn('grid min-w-0 gap-4 rounded-[var(--radius-card)] border border-line bg-[var(--surface-card)] p-4 md:p-6', className)}>
    <header className="grid gap-2">
      <h2 id={id} className="m-0 text-h2 font-semibold leading-tight">{title}</h2>
      {description && <p className="m-0 text-small text-secondary">{description}</p>}
    </header>
    <div className="flex min-w-0 flex-wrap items-start gap-6">{children}</div>
  </section>;
}

export function KitState({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const id = useId();
  return <div role="group" aria-labelledby={id} className={cn('grid min-w-0 max-w-full gap-3', className)}>
    <p id={id} className="m-0 text-small font-medium text-secondary">{label}</p>
    <div className="min-w-0">{children}</div>
  </div>;
}
