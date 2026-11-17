/** shadcn/ui breadcrumb structure, styled with wiki typography and tokens. */
import { Fragment, forwardRef, type ComponentProps, type HTMLAttributes, type MouseEventHandler } from 'react';
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

/** One stop of a page's trail: the word it shows, and the address it opens when it names a page. */
export interface TrailCrumb {
  readonly label: string;
  readonly href?: string;
  readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
  readonly onAuxClick?: MouseEventHandler<HTMLAnchorElement>;
}

/**
 * The page's trail, directly above the title: every stop in the order the page walked it, each one a link where it
 * names a page, and the page's own name last (madarch-64o5.134). The trail keeps one line: a long stop truncates and
 * the last one keeps its end, so the page's name stays readable.
 */
export function PageBreadcrumb({ items, label, className, ...props }: Omit<ComponentProps<'nav'>, 'children'> & { readonly items: readonly TrailCrumb[]; readonly label: string }) {
  if (items.length === 0) return null;

  return (
    <Breadcrumb aria-label={label} data-testid="trail" className={cn('page-trail', className)} {...props}>
      <BreadcrumbList className="flex-nowrap">
        {items.map((item, at) => {
          const last = at === items.length - 1;
          return (
            <Fragment key={`${item.label}-${String(at)}`}>
              {at === 0 ? null : <BreadcrumbSeparator className="shrink-0">/</BreadcrumbSeparator>}
              <BreadcrumbItem className={last ? 'min-w-0' : 'min-w-0 shrink-[1]'}>
                {last
                  ? <BreadcrumbPage className="block truncate">{item.label}</BreadcrumbPage>
                  : item.href === undefined
                    ? <span className="block truncate">{item.label}</span>
                    : <a href={item.href} onClick={item.onClick} className="block truncate rounded-[var(--radius-control)] text-secondary no-underline outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-ink">{item.label}</a>}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
