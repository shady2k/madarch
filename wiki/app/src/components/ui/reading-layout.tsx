/** Reading-page panels and semantic structure shared by operational pages. */
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export function ReadingPanel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('rounded-[var(--radius-card)] border border-line p-3', className)} {...props} />;
}
export function ReadingPanelItem({ className, ...props }: HTMLAttributes<HTMLLIElement>) {
  return <li className={cn('min-w-0 rounded-[var(--radius-card)] border border-line p-3', className)} {...props} />;
}
export function ReadingQuote({ className, ...props }: HTMLAttributes<HTMLQuoteElement>) {
  return <blockquote className={cn('m-0 whitespace-pre-wrap rounded-[var(--radius-card)] border border-line bg-[var(--surface-soft)] p-3 text-body', className)} {...props} />;
}
export function DetailTitle(props: HTMLAttributes<HTMLHeadingElement>) { return <h4 {...props} />; }
export function WrappingList({ className, ...props }: HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn('m-0 grid min-w-0 list-none gap-3 p-0 [overflow-wrap:anywhere]', className)} {...props} />;
}
