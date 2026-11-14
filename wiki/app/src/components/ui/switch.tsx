/** shadcn/ui switch, backed by the Radix checked-state and form primitive. */
import { forwardRef, type ComponentProps } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils.js';

export const Switch = forwardRef<HTMLButtonElement, ComponentProps<typeof SwitchPrimitive.Root>>(function Switch({ className, ...props }, ref) {
  return <SwitchPrimitive.Root ref={ref} className={cn('inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-line bg-[var(--surface-active)] p-0.5 outline-none transition-colors motion-reduce:transition-none aria-invalid:border-ink aria-invalid:ring-2 aria-invalid:ring-ink/30 focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page data-[state=checked]:border-ink data-[state=checked]:bg-ink disabled:cursor-not-allowed disabled:opacity-50', className)} {...props}>
    <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-page shadow-[var(--shadow-low)] transition-transform motion-reduce:transition-none data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>;
});
