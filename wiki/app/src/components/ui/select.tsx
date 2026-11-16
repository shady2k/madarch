import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  options: readonly { value: string; label: string }[];
  variant?: 'default' | 'filter';
};
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, options, variant = 'default', ...props }, ref) {
  const select = <select ref={ref} className={cn('h-9 rounded-[var(--radius-control)] border border-line bg-page px-3 text-small text-ink focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50', variant === 'filter' && 'w-full appearance-none pr-8', className)} {...props}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  return variant === 'filter' ? <div className="relative">{select}<ChevronDownIcon aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" size={15} /></div> : select;
});
