/** shadcn/ui radio group, with Radix roving focus and native form support. */
import { forwardRef, type ComponentProps } from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { CircleIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';

export const RadioGroup = forwardRef<HTMLDivElement, ComponentProps<typeof RadioGroupPrimitive.Root>>(function RadioGroup({ className, ...props }, ref) {
  return <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-2 [&[aria-invalid=true]_[role=radio]]:border-ink [&[aria-invalid=true]_[role=radio]]:ring-2 [&[aria-invalid=true]_[role=radio]]:ring-ink/30', className)} {...props} />;
});

export const RadioGroupItem = forwardRef<HTMLButtonElement, ComponentProps<typeof RadioGroupPrimitive.Item>>(function RadioGroupItem({ className, ...props }, ref) {
  return <RadioGroupPrimitive.Item ref={ref} className={cn('aspect-square size-4 shrink-0 rounded-full border border-[var(--text-muted)] bg-page text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page aria-invalid:border-ink aria-invalid:ring-2 aria-invalid:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props}>
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center"><CircleIcon aria-hidden="true" className="size-2 fill-current" /></RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>;
});
