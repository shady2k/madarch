import { forwardRef, type ComponentProps } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = forwardRef<HTMLDivElement, ComponentProps<typeof PopoverPrimitive.Content>>(function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }, ref) {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset}
      className={cn('wiki-modal-layer max-w-[calc(100vw-2rem)] rounded-[var(--radius-card)] border border-line bg-[var(--surface-menu)] p-3 text-small text-ink shadow-[var(--shadow-high)] outline-none', className)}
      {...props} />
  </PopoverPrimitive.Portal>;
});
