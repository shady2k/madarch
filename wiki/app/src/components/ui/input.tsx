/**
 * The shadcn/ui Input, copied in the new-york shape and re-themed from the
 * wiki's own design tokens: the line border, the control radius, the ink ring.
 */
import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, type = 'text', ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'ui-input h-9 w-full rounded-[var(--radius-control)] border border-line bg-page px-3 text-small text-ink outline-none placeholder:text-muted',
        'focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
