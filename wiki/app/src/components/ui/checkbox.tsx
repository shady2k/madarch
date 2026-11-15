/**
 * The shadcn/ui Checkbox, copied in the new-york shape and re-themed from the
 * wiki's own design tokens. Radix's checkbox primitive carries the checked and
 * indeterminate states, the hidden form input and the aria attributes; the
 * three states are told by the ink and a mark, never by hue.
 */
import { forwardRef, type ComponentProps } from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { CheckIcon, MinusIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';

export const Checkbox = forwardRef<HTMLButtonElement, ComponentProps<typeof CheckboxPrimitive.Root>>(function Checkbox({ className, ...props }, ref) {
  return <CheckboxPrimitive.Root
    ref={ref}
    className={cn('peer grid size-4 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-control)] border border-ink/45 bg-[var(--surface-soft)] text-ink outline-none transition-colors hover:border-ink focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-ink data-[state=indeterminate]:border-ink [&[data-state=checked]]:bg-[var(--surface-active)] [&[data-state=indeterminate]]:bg-[var(--surface-active)]', className)}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="grid place-items-center text-ink">
      <CheckIcon aria-hidden="true" size={12} className="[[data-state=indeterminate]_&]:hidden" />
      <MinusIcon aria-hidden="true" size={12} className="hidden [[data-state=indeterminate]_&]:block" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
});
