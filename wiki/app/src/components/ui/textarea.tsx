/**
 * The shadcn/ui Textarea in the Input's re-themed shape: the line border, the
 * control radius, the ink ring.
 */
import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'ui-textarea block w-full rounded-[var(--radius-control)] border border-line bg-page px-3 py-2 text-small text-ink outline-none placeholder:text-muted',
        'focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
