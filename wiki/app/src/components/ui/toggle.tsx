/**
 * The shadcn/ui Toggle, copied in the new-york shape and re-themed from the
 * wiki's own design tokens (graphite pairs, the pressed state on the pill
 * ground). Radix's toggle primitive underneath carries the pressed state and
 * its aria attributes.
 */
import { forwardRef, type ReactElement } from 'react';
import * as TogglePrimitive from '@radix-ui/react-toggle';
import { cn } from '@/lib/utils.js';

export type ToggleProps = React.ComponentProps<typeof TogglePrimitive.Root>;

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { className, ...props },
  ref,
): ReactElement {
  return (
    <TogglePrimitive.Root
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center rounded-[5px] text-secondary outline-none',
        'hover:bg-pill hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        'data-[state=on]:bg-pill data-[state=on]:text-ink disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
