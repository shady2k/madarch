import { forwardRef, type ComponentProps, type ReactElement } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverContent = forwardRef<HTMLDivElement, ComponentProps<typeof PopoverPrimitive.Content>>(function PopoverContent(
  { className, align = 'center', sideOffset = 4, ...props }, ref,
): ReactElement {
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset}
    className={cn('z-50 w-80 max-w-[calc(100vw-2rem)] rounded-[var(--radius-card)] border border-line bg-page p-4 text-ink shadow-lg outline-none', className)} {...props} /></PopoverPrimitive.Portal>;
});
