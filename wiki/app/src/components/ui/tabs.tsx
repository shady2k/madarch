/**
 * The shadcn/ui Tabs shape, themed with the wiki's design tokens. Radix
 * supplies selection, panel relationships, and roving keyboard focus.
 */
import { forwardRef, type ComponentProps, type ReactElement } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils.js';

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref): ReactElement {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'ui-tabs-list inline-flex h-9 items-center justify-center rounded-[var(--radius-control)] bg-chrome p-1 text-secondary',
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref): ReactElement {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'ui-tabs-trigger inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] px-3 py-1 text-small font-medium outline-none transition-colors duration-150 motion-reduce:transition-none',
        'hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        'data-[state=active]:bg-[var(--surface-active)] data-[state=active]:text-ink disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref): ReactElement {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        'ui-tabs-content mt-2 outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        className,
      )}
      {...props}
    />
  );
});
