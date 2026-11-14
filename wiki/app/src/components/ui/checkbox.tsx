import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function Checkbox({ className, ...props }, ref) {
  return <input ref={ref} type="checkbox" className={cn('h-4 w-4 shrink-0 accent-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50', className)} {...props} />;
});
