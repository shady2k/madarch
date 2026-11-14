/**
 * The shadcn/ui Tooltip, copied in the new-york shape and re-themed from the
 * wiki's own design tokens (the ink/chrome graphite pair, the line border).
 * Radix's tooltip primitive underneath; the provider wraps the toolbar.
 */
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

export const TooltipProvider = TooltipPrimitive.Provider;

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export function TooltipContent({ children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal><TooltipPrimitive.Content className="rounded-[var(--radius-control)] border border-line bg-[var(--surface-menu)] px-3 py-2 text-small text-ink shadow-[var(--shadow-medium)]" sideOffset={4} {...props}>{children}</TooltipPrimitive.Content></TooltipPrimitive.Portal>;
}
