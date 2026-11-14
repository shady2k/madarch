import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

/** Native radio for label-wrapped choices that retain browser form behavior. */
export const RadioInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function RadioInput({ className, ...props }, ref) {
  return <input ref={ref} type="radio" className={cn('size-4 shrink-0 accent-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50', className)} {...props} />;
});
