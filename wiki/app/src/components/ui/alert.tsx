/**
 * The shadcn/ui Alert, copied in the new-york shape and re-themed from the
 * wiki's own design tokens. A notice on a page: a problem the page carries is
 * told by a dashed edge and its words.
 */
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export type AlertVariant = 'default' | 'problem';

const variants: Record<AlertVariant, string> = {
  default: 'border border-line bg-[var(--surface-soft)]',
  problem: 'border border-dashed border-ink bg-[var(--surface-soft)]',
};

export const Alert = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant }>(function Alert({ className, variant = 'default', ...props }, ref) {
  return <div ref={ref} role="alert" className={cn('ui-alert rounded-[var(--radius-card)] px-4 py-3 text-small text-ink', variants[variant], className)} {...props} />;
});

export const AlertTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(function AlertTitle({ className, ...props }, ref) {
  return <h5 ref={ref} className={cn('!m-0 text-small font-[600] leading-snug', className)} {...props} />;
});

export const AlertDescription = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function AlertDescription({ className, ...props }, ref) {
  return <div ref={ref} className={cn('mt-1 text-small text-secondary [&_p]:!m-0', className)} {...props} />;
});
