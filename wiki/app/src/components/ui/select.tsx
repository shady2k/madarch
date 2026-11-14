/**
 * The shadcn/ui Select, copied in the new-york shape and re-themed from the
 * wiki's own design tokens. Radix's select primitive carries the list's own
 * keyboard behaviour, the type-ahead and the portal; the trigger, the items and
 * the scroll buttons take the kit's surfaces, so a menu opened over a page is
 * the page's own.
 */
import { forwardRef, type ComponentProps, type ComponentPropsWithoutRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';

/**
 * The item that stands for "no choice": Radix refuses an item whose value is the empty string, so a menu that offers
 * "none" names it with this value and the caller maps it back to the empty one.
 */
export const UNSORTED = '__none__';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(function SelectTrigger({ className, children, ...props }, ref) {
  return <SelectPrimitive.Trigger
    ref={ref}
    className={cn('flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-page px-3 text-small text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate', className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild><ChevronDownIcon aria-hidden="true" size={14} className="shrink-0 text-muted" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
});

export const SelectContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(function SelectContent({ className, children, position = 'popper', ...props }, ref) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn('relative z-50 max-h-[var(--radix-select-content-available-height)] min-w-[8rem] overflow-hidden rounded-[var(--radius-card)] border border-line bg-[var(--surface-menu)] text-ink shadow-[var(--shadow-high)]', position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1', className)}
      {...props}
    >
      <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-muted"><ChevronUpIcon aria-hidden="true" size={14} /></SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-muted"><ChevronDownIcon aria-hidden="true" size={14} /></SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>;
});

export const SelectItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(function SelectItem({ className, children, ...props }, ref) {
  return <SelectPrimitive.Item
    ref={ref}
    className={cn('relative flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius-row)] py-1.5 pl-2 pr-8 text-small text-ink outline-none focus:bg-[var(--surface-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)}
    {...props}
  >
    <span className="absolute right-2 grid size-3.5 place-items-center"><SelectPrimitive.ItemIndicator><CheckIcon aria-hidden="true" size={14} /></SelectPrimitive.ItemIndicator></span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>;
});

