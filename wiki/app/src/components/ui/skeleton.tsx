/**
 * The shadcn/ui Skeleton: a quiet pulsing bar that stands where text will be,
 * in the wiki's own surface token. It is decoration: the region it sits in
 * says it is busy.
 */
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('ui-skeleton animate-pulse rounded-[var(--radius-row)] bg-[var(--surface-active)] motion-reduce:animate-none', className)} {...props} />;
}
