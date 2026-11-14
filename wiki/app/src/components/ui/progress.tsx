/** shadcn/ui progress, using Radix for determinate and indeterminate semantics. */
import { forwardRef, type ComponentProps } from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '@/lib/utils.js';

export const Progress = forwardRef<HTMLDivElement, ComponentProps<typeof ProgressPrimitive.Root>>(function Progress({ className, value, max = 100, ...props }, ref) {
  const limit = Number.isFinite(max) && max > 0 ? max : 100;
  const current = typeof value === 'number' && Number.isFinite(value) ? Math.min(limit, Math.max(0, value)) : null;
  return <ProgressPrimitive.Root ref={ref} value={current} max={limit} className={cn('relative h-2 w-full overflow-hidden rounded-full bg-[var(--surface-active)]', className)} {...props}>
    <ProgressPrimitive.Indicator className="h-full w-full bg-ink transition-transform motion-reduce:transition-none data-[state=indeterminate]:opacity-50" style={{ transform: current === null ? undefined : `translateX(-${100 - current / limit * 100}%)` }} />
  </ProgressPrimitive.Root>;
});
