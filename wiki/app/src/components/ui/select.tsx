import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { options: readonly { value: string; label: string }[] };
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, options, ...props }, ref) {
  return <select ref={ref} className={cn('h-9 rounded-[var(--radius-control)] border border-line bg-page px-3 text-small text-ink focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50', className)} {...props}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
});
