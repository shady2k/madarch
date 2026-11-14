import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

/** An in-flow confirmation, not a modal dialog or a focus trap. */
export function ConfirmationPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="group" className={cn('mt-3 grid min-w-0 gap-2 rounded-[var(--radius-card)] border border-dashed border-ink bg-[var(--surface-soft)] p-4 text-small text-secondary [overflow-wrap:anywhere]', className)} {...props} />;
}
