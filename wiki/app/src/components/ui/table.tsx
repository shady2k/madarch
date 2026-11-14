/**
 * The shadcn/ui Table, copied in the new-york shape and re-themed from the
 * wiki's own design tokens: the line border, the small type step, the zebra
 * and hover surfaces. A wide table scrolls inside its own container, never the
 * page.
 */
import { forwardRef, type ColHTMLAttributes, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

type TableProps = HTMLAttributes<HTMLTableElement> & { layout?: 'auto' | 'fixed'; density?: 'default' | 'compact' };

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table({ className, layout = 'auto', density = 'default', ...props }, ref) {
  return (
    <div className="table-wrap ui-table-wrap relative w-full overflow-x-auto rounded-[var(--radius-card)] border border-line">
      <table ref={ref} className={cn('ui-table m-0 w-full caption-bottom border-collapse text-small', layout === 'fixed' && 'table-fixed min-w-full', density === 'compact' && '[&_td]:px-2 [&_th]:px-2', className)} {...props} />
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

export const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(function TableHead({ className, align, ...props }, ref) {
  return <th ref={ref} className={cn('h-9 whitespace-nowrap px-3 text-left align-middle text-small font-[550] text-secondary', align === 'right' && 'text-right', align === 'center' && 'text-center', className)} {...props} />;
});

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(function TableCell({ className, align, ...props }, ref) {
  return <td ref={ref} className={cn('px-3 py-2 align-middle text-small text-ink', align === 'right' && 'text-right', align === 'center' && 'text-center', className)} {...props} />;
});

/** Named column sizes keep fixed tables readable while the table container handles overflow. */
type ColumnWidth = 'auto' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
const columnWidths: Record<ColumnWidth, string> = { auto: '', xs: 'w-14', sm: 'w-16', md: 'w-20', lg: 'w-28', xl: 'w-32' };
export function TableColumn({ width = 'auto', className, ...props }: ColHTMLAttributes<HTMLTableColElement> & { width?: ColumnWidth }) {
  return <col className={cn(columnWidths[width], className)} {...props} />;
}
