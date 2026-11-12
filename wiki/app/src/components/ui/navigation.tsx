/** Shared product navigation controls and their visual hierarchy. */
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Metadata, Text } from './typography.js';

export const NavigationLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { active?: boolean; empty?: boolean; depth?: 0 | 1 | 2 }>(function NavigationLink({ active, empty, depth = 0, className, ...props }, ref) {
  return <a ref={ref} aria-current={active ? 'page' : undefined} className={cn('nav-link my-px flex items-center gap-2.5 rounded-[var(--radius-row)] px-[10px] py-[9px] text-small no-underline transition-colors duration-150 motion-reduce:transition-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted', active ? 'nav-current bg-[var(--surface-active)] font-[550] text-ink' : 'text-secondary hover:bg-[var(--surface-hover)] hover:text-ink', empty && 'text-muted opacity-60', depth === 1 && 'py-[7px] pl-[30px]', depth === 2 && 'py-[7px] pl-[42px]', className)} {...props} />;
});
export function NavigationLabel(props: HTMLAttributes<HTMLSpanElement>) { return <Text className="min-w-0 flex-1 truncate" {...props} />; }
export function NavigationCount(props: HTMLAttributes<HTMLSpanElement>) { return <Metadata {...props} />; }
export function NavigationPending(props: HTMLAttributes<HTMLSpanElement>) { return <Text className="ml-1" {...props} />; }
export function NavigationScroll(props: HTMLAttributes<HTMLElement>) { return <nav className="min-h-0 flex-1 overflow-y-auto pb-4 pr-2 [scrollbar-gutter:stable]" {...props} />; }
export function NavigationSection(props: HTMLAttributes<HTMLDivElement>) { return <div className="mb-2 mt-2" {...props} />; }
export function NavigationHeading(props: HTMLAttributes<HTMLHeadingElement>) { return <h2 className="mb-1.5 mt-4 px-2 text-[12px] uppercase tracking-[0.08em] text-muted" {...props} />; }
export function NavigationGroup(props: HTMLAttributes<HTMLDivElement>) { return <div className="mb-0.5" {...props} />; }
export function NavigationGroupTrigger({ open, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { open: boolean }) {
 return <button type="button" aria-expanded={open} className="nav-group flex w-full cursor-pointer items-center gap-1.5 rounded-[var(--radius-row)] px-[6px] py-[7px] text-left text-small font-[550] text-ink hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ink" {...props}><ChevronRightIcon aria-hidden="true" className={cn('size-4 shrink-0 text-muted transition-transform motion-reduce:transition-none', open && 'rotate-90')} />{children}</button>;
}
export function NavigationSubheading(props: HTMLAttributes<HTMLDivElement>) { return <div className="flex items-center gap-2 py-[5px] pl-[30px] pr-[10px] text-[11px] uppercase tracking-[0.06em] text-muted" {...props} />; }
export function NavigationFooter(props: HTMLAttributes<HTMLDivElement>) { return <div className="border-t border-line py-2" {...props} />; }
export const ProductButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { name: string; description: string }>(function ProductButton({ name, description, ...props }, ref) {
 return <button type="button" ref={ref} className="nav-product-block mb-3 flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-card)] border border-line bg-[var(--surface-card)] px-[9px] py-2 text-left shadow-[var(--shadow-low)] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2" {...props}><span aria-hidden="true" className="product-initial grid size-[40px] shrink-0 place-items-center rounded-[var(--radius-control)] bg-page font-serif text-[22px] font-medium text-ink shadow-[var(--shadow-low)]">{name.charAt(0).toUpperCase()}</span><span className="min-w-0 flex-1"><b className="block truncate text-[13px] leading-5 text-ink">{name}</b><small className="block text-[11px] leading-4 text-muted">{description}</small></span><ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted" /></button>;
});
export function BrandLink({ children, concept, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { concept: ReactNode }) { return <a className="nav-brand flex items-center gap-2.5 px-2 py-[14px] text-ink no-underline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2" {...props}>{children}<strong className="text-[23px] font-[650] leading-none tracking-[-0.8px]">madarch</strong><small className="nav-concept ml-auto rounded-[var(--radius-row)] border border-line px-[5px] py-0.5 text-[11px] leading-4 text-muted">{concept}</small></a>; }
