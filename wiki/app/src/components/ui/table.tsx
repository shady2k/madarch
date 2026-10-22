/**
 * The shadcn/ui Table, copied in the new-york shape and re-themed from the
 * wiki's own design tokens: the line border, the small type step, the zebra
 * and hover surfaces. A wide table scrolls inside its own container, never the
 * page.
 */
import { forwardRef, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(function Table({ className, ...props }, ref) {
  return (
    <div className="ui-table-wrap relative w-full overflow-x-auto rounded-[var(--radius-card)] border border-line">
      <table ref={ref} className={cn('ui-table m-0 w-full caption-bottom border-collapse text-small', className)} {...props} />
    </div>
  );
});

export const TableHeader = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} className={cn('bg-[var(--surface-soft)] [&_tr]:border-b [&_tr]:border-line', className)} {...props} />;
});

export const TableBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
});

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(function TableRow({ className, ...props }, ref) {
  return <tr ref={ref} className={cn('border-b border-line transition-colors hover:bg-[var(--surface-hover)] motion-reduce:transition-none', className)} {...props} />;
});

export const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(function TableHead({ className, ...props }, ref) {
  return <th ref={ref} className={cn('h-9 whitespace-nowrap px-3 text-left align-middle text-small font-[550] text-secondary', className)} {...props} />;
});

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(function TableCell({ className, ...props }, ref) {
  return <td ref={ref} className={cn('px-3 py-2 align-middle text-small text-ink', className)} {...props} />;
});
