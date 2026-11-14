/**
 * The shadcn/ui DropdownMenu, copied in the new-york shape and re-themed from
 * the wiki's own design tokens. Radix's dropdown primitive underneath, the
 * same package the language menu already uses.
 */
import { forwardRef, type ComponentProps } from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils.js';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuContent = forwardRef<HTMLDivElement, ComponentProps<typeof DropdownMenuPrimitive.Content>>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'ui-menu wiki-modal-layer min-w-[220px] overflow-hidden rounded-[var(--radius-card)] border border-line bg-[var(--surface-menu)] p-1 text-ink shadow-[var(--shadow-high)]',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuLabel = forwardRef<HTMLDivElement, ComponentProps<typeof DropdownMenuPrimitive.Label>>(function DropdownMenuLabel({ className, ...props }, ref) {
  return <DropdownMenuPrimitive.Label ref={ref} className={cn('px-2 py-1.5 text-[12px] uppercase tracking-[0.08em] text-muted', className)} {...props} />;
});

export const DropdownMenuItem = forwardRef<HTMLDivElement, ComponentProps<typeof DropdownMenuPrimitive.Item>>(function DropdownMenuItem({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-[var(--radius-row)] px-2 py-1.5 text-small outline-none data-[highlighted]:bg-[var(--surface-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuRadioItem = forwardRef<HTMLDivElement, ComponentProps<typeof DropdownMenuPrimitive.RadioItem>>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return <DropdownMenuPrimitive.RadioItem ref={ref} className={cn('relative flex cursor-default select-none items-center gap-2 rounded-[var(--radius-row)] px-2 py-1.5 text-small outline-none data-[highlighted]:bg-[var(--surface-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)} {...props}><span className="grid size-4 place-items-center"><DropdownMenuPrimitive.ItemIndicator>✓</DropdownMenuPrimitive.ItemIndicator></span>{children}</DropdownMenuPrimitive.RadioItem>;
});
export const DropdownMenuSeparator = forwardRef<HTMLDivElement, ComponentProps<typeof DropdownMenuPrimitive.Separator>>(function DropdownMenuSeparator({ className, ...props }, ref) { return <DropdownMenuPrimitive.Separator ref={ref} className={cn('my-1 h-px bg-line', className)} {...props} />; });
