/** Shared reading-page structure and typography, themed by the wiki tokens. */
import { forwardRef, type HTMLAttributes, type AnchorHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export const PageSection = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function PageSection({ className, ...props }, ref) {
  return <section ref={ref} className={cn('min-w-0', className)} {...props} />;
});
export function PageHeader({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <header className={cn('mb-6', className)} {...props} />;
}
export function PageTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className={cn('text-title', className)} {...props} />;
}
export function SectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-h2', className)} {...props} />;
}
export function Paragraph({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-body', className)} {...props} />;
}
export function BulletList({ className, ...props }: HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn('list-disc pl-6', className)} {...props} />;
}
export function ListItem(props: HTMLAttributes<HTMLLIElement>) { return <li {...props} />; }
export function Metadata({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('text-small text-muted', className)} {...props} />;
}
export function InlineGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-2 flex flex-wrap items-center gap-2', className)} {...props} />;
}
export const CodeFrame = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CodeFrame({ className, ...props }, ref) {
  return <div ref={ref} className={cn('source-view overflow-hidden rounded-[var(--radius-card)] border border-line', className)} {...props} />;
});
export function FileTitle(props: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className="break-all font-mono text-h2" {...props} />;
}

export function TextLink({ className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cn('text-ink underline decoration-current underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2', className)} {...props} />;
}
