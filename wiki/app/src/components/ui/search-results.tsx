/** Non-modal, keyboard-navigated result list for a search field. */
import { forwardRef, type HTMLAttributes, type AnchorHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export const SearchContainer = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SearchContainer({ className, ...props }, ref) {
  return <div ref={ref} className={cn('shell-search', className)} {...props} />;
});

export function SearchResults({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('shell-search-results absolute right-0 top-full z-50 mt-1.5 max-h-[70vh] w-[min(28rem,92vw)] overflow-y-auto rounded-[var(--radius-card)] border border-line bg-page p-2 text-left shadow-[var(--shadow-high)]', className)} {...props} />;
}
export function SearchGroupTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mb-1 mt-2 px-2 text-small uppercase tracking-wide text-muted first:mt-0', className)} {...props} />;
}
export function SearchResultLink({ active, className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { active: boolean }) {
  return <a className={cn('block rounded-[var(--radius-row)] px-2 py-1.5 no-underline', active ? 'bg-[var(--surface-active)] text-ink' : 'text-secondary hover:bg-[var(--surface-hover)] hover:text-ink', className)} {...props} />;
}
