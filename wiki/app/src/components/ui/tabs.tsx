/** shadcn/ui tabs, backed by Radix keyboard navigation and wiki tokens. */
import { forwardRef, type ComponentProps } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils.js';

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<HTMLDivElement, ComponentProps<typeof TabsPrimitive.List>>(function TabsList({ className, ...props }, ref) {
  return <TabsPrimitive.List ref={ref} className={cn('inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-[var(--surface-soft)] p-1 text-small text-secondary', className)} {...props} />;
});

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentProps<typeof TabsPrimitive.Trigger>>(function TabsTrigger({ className, ...props }, ref) {
  return <TabsPrimitive.Trigger ref={ref} className={cn('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] px-3 py-1.5 font-medium outline-none transition-colors motion-reduce:transition-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page data-[state=active]:bg-page data-[state=active]:text-ink data-[state=active]:shadow-[var(--shadow-low)] disabled:pointer-events-none disabled:opacity-50', className)} {...props} />;
});

export const TabsContent = forwardRef<HTMLDivElement, ComponentProps<typeof TabsPrimitive.Content>>(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn('mt-3 outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page', className)} {...props} />;
});
