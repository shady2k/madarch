/**
 * The shadcn/ui ToggleGroup, copied in the new-york shape and re-themed from
 * the wiki's own design tokens. Radix's toggle group carries single and
 * multiple selection with roving focus; the items share the toggle's pressed
 * ground, so the chosen one is told by its fill and its weight, never by hue.
 */
import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef } from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/utils.js';

type ToggleGroupVariant = 'default' | 'outline';
type ToggleGroupSize = 'default' | 'sm';

const ToggleGroupContext = createContext<{ variant: ToggleGroupVariant; size: ToggleGroupSize }>({ variant: 'default', size: 'default' });

export const ToggleGroup = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> & { variant?: ToggleGroupVariant; size?: ToggleGroupSize }>(function ToggleGroup({ className, variant = 'default', size = 'default', children, ...props }, ref) {
  return <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn('flex items-center gap-0.5 rounded-[var(--radius-control)] border border-line p-0.5', className)}
    {...props}
  >
    <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
  </ToggleGroupPrimitive.Root>;
});

export const ToggleGroupItem = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>>(function ToggleGroupItem({ className, children, ...props }, ref) {
  const { variant, size } = useContext(ToggleGroupContext);
  return <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      'inline-flex cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-[var(--radius-control)] font-medium text-secondary outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-[var(--surface-active)] data-[state=on]:font-semibold data-[state=on]:text-ink',
      variant === 'outline' && 'border border-line bg-page',
      size === 'default' ? 'h-8 px-2.5 text-small' : 'h-7 px-2 text-[13px]',
      className,
    )}
    {...props}
  >{children}</ToggleGroupPrimitive.Item>;
});
