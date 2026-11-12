/** Shared reading-page structure and typography, themed by the wiki tokens. */
import { forwardRef, type HTMLAttributes, type FormHTMLAttributes, type LabelHTMLAttributes, type AnchorHTMLAttributes } from 'react';
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
export function Preformatted(props: HTMLAttributes<HTMLPreElement>) { return <pre {...props} />; }

export function FileTitle(props: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className="break-all font-mono text-h2" {...props} />;
}

export function TextLink({ className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cn('text-ink underline decoration-current underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2', className)} {...props} />;
}

/** Shared semantic layout for reading pages and form fields. */
const stackLayouts = {
  fill: 'grid min-w-0 gap-6 lg:grid-cols-[minmax(18rem,1fr)_minmax(0,2fr)]',
  graph: 'max-h-[32rem] overflow-auto',
  catalogue: 'grid min-w-0 items-start gap-6 md:grid-cols-[minmax(0,1fr)_200px]',
  reading: 'max-w-[var(--measure)]',
  navigation: 'flex min-h-0 h-full w-full flex-col px-[14px] wide:px-[18px]',
  shell: 'shell flex h-dvh overflow-hidden bg-page text-ink [font-family:var(--font-sans)] text-body',
};
export function Stack({ layout, className, ...props }: HTMLAttributes<HTMLDivElement> & { layout?: keyof typeof stackLayouts }) { return <div className={cn(layout && stackLayouts[layout], className)} {...props} />; }
export function Text(props: HTMLAttributes<HTMLSpanElement>) { return <span {...props} />; }
export function PageArticle(props: HTMLAttributes<HTMLElement>) { return <article {...props} />; }
export function DefinitionList({ columns = false, className, ...props }: HTMLAttributes<HTMLDListElement> & { columns?: boolean }) { return <dl className={cn(columns && 'm-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-small', className)} {...props} />; }
export function DefinitionTerm(props: HTMLAttributes<HTMLElement>) { return <dt {...props} />; }
export function DefinitionValue(props: HTMLAttributes<HTMLElement>) { return <dd {...props} />; }
export function PlainList(props: HTMLAttributes<HTMLUListElement>) { return <ul {...props} />; }
export function SmallTitle(props: HTMLAttributes<HTMLHeadingElement>) { return <h3 {...props} />; }
export function Form({ className, ...props }: FormHTMLAttributes<HTMLFormElement>) { return <form className={cn('my-4 max-w-2xl space-y-4', className)} {...props} />; }
export function FieldLabel(props: LabelHTMLAttributes<HTMLLabelElement>) { return <label {...props} />; }

export function ContentsSidebar({ className, ...props }: HTMLAttributes<HTMLElement>) { return <aside className={cn('order-first md:order-last md:sticky md:top-4 md:max-h-[calc(100dvh-10rem)] md:overflow-y-auto', className)} {...props} />; }
export function ClippedLabel({ className, ...props }: HTMLAttributes<HTMLSpanElement>) { return <span className={cn('min-w-0 max-w-[12rem] truncate', className)} {...props} />; }
