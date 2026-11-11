/** shadcn/ui popover with Radix dismissal and focus management. */
import { forwardRef, type ComponentProps, type HTMLAttributes } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils.js';

const popoverSurface = 'rounded-[var(--radius-panel)] border border-line bg-[var(--surface-menu)] p-4 text-small text-ink shadow-[var(--shadow-high)]';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<HTMLDivElement, ComponentProps<typeof PopoverPrimitive.Content>>(function PopoverContent({ className, align = 'center', sideOffset = 6, ...props }, ref) {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} className={cn('wiki-modal-layer w-80 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-[var(--surface-menu)] p-4 text-small text-ink shadow-[var(--shadow-high)] outline-none', className)} {...props} />
  </PopoverPrimitive.Portal>;
});

/** The popover surface in document flow, without dismissal or focus management. */
export function PopoverPreview({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(popoverSurface, 'w-80 max-w-full', className)} {...props} />;
}
