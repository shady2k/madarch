/** Shared wrapping filters and pagination for data views. */
import type { HTMLAttributes, LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export function FilterBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-2.5 flex flex-wrap items-end gap-x-3.5 gap-y-2', className)} {...props} />;
}

/** Nest the input to keep its visible label and accessible name together. */
export function FilterField({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('flex min-w-0 flex-1 flex-col gap-1 text-small text-secondary sm:flex-none [&_input]:w-full [&_select]:w-full sm:[&_input]:w-48 sm:[&_select]:w-48', className)} {...props} />;
}

export function PaginationBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-1 mt-2.5 flex flex-wrap items-center gap-2 text-small text-secondary', className)} {...props} />;
}

export function PaginationSummary({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('flex-auto', className)} {...props} />;
}
