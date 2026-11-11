/** shadcn/ui breadcrumb structure, styled with wiki typography and tokens. */
import { forwardRef, type ComponentProps, type HTMLAttributes } from 'react';
import { ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';

export const Breadcrumb = forwardRef<HTMLElement, ComponentProps<'nav'>>(function Breadcrumb({ 'aria-label': label = 'Breadcrumb', ...props }, ref) {
  return <nav ref={ref} aria-label={label} {...props} />;
});

export const BreadcrumbList = forwardRef<HTMLOListElement, ComponentProps<'ol'>>(function BreadcrumbList({ className, ...props }, ref) {
  return <ol ref={ref} className={cn('m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-small text-secondary', className)} {...props} />;
});

export const BreadcrumbItem = forwardRef<HTMLLIElement, ComponentProps<'li'>>(function BreadcrumbItem({ className, ...props }, ref) {
  return <li ref={ref} className={cn('inline-flex items-center gap-1.5', className)} {...props} />;
});

export const BreadcrumbLink = forwardRef<HTMLAnchorElement, ComponentProps<'a'>>(function BreadcrumbLink({ className, ...props }, ref) {
  return <a ref={ref} className={cn('rounded-[var(--radius-control)] text-secondary no-underline outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-ink', className)} {...props} />;
});

export const BreadcrumbPage = forwardRef<HTMLSpanElement, ComponentProps<'span'>>(function BreadcrumbPage({ className, ...props }, ref) {
  return <span ref={ref} aria-current="page" className={cn('font-normal text-ink', className)} {...props} />;
});

export function BreadcrumbSeparator({ children, className, ...props }: HTMLAttributes<HTMLLIElement>) {
  return <li aria-hidden="true" role="presentation" className={cn('inline-flex items-center [&>svg]:size-3.5', className)} {...props}>{children ?? <ChevronRightIcon />}</li>;
}

export function BreadcrumbEllipsis({ className, ...props }: ComponentProps<'span'>) {
  return <span aria-hidden="true" className={cn('flex size-6 items-center justify-center', className)} {...props}><MoreHorizontalIcon className="size-4" /></span>;
}
