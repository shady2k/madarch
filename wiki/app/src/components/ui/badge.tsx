/**
 * The shadcn/ui Badge, copied in the new-york shape and re-themed from the
 * wiki's own design tokens. Two variants only: the quiet outline a kind or a
 * language wears, and the filled one a state wears. The palette is the
 * graphite pair, so a state is told by its word and its weight, never by hue.
 */
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export type BadgeVariant = 'outline' | 'solid';

const variants: Record<BadgeVariant, string> = {
  outline: 'border border-line text-muted',
  solid: 'border border-ink bg-ink text-page',
};

export const Badge = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }>(function Badge({ className, variant = 'outline', ...props }, ref) {
  return <span ref={ref} className={cn('ui-badge inline-flex shrink-0 items-center rounded-[var(--radius-row)] px-[6px] py-px text-[12px] leading-4', variants[variant], className)} {...props} />;
});
