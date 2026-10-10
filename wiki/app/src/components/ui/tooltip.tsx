/**
 * The shadcn/ui Tooltip, copied in the new-york shape and re-themed from the
 * wiki's own design tokens (the ink/chrome graphite pair, the line border).
 * Radix's tooltip primitive underneath; the provider wraps the toolbar.
 */
import { forwardRef, type ReactElement } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils.js';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref): ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-[5px] bg-ink px-2 py-1 text-small text-page shadow-md',
          'data-[state=delayed-open]:data-[side=top]:animate-in data-[state=delayed-open]:data-[side=bottom]:animate-in [--tw-ring-color:transparent]',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
