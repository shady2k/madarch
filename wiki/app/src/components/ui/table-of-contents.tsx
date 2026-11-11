import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.js';

export interface ContentsItem {
  id: string;
  label: string;
  children?: readonly ContentsItem[];
}

/** In-page navigation; a caller may mount a different view before scrolling. */
export function TableOfContents({ title, items, onNavigate, className }: {
  title: string;
  items: readonly ContentsItem[];
  onNavigate?: (id: string) => void;
  className?: string;
}): ReactElement {
  const list = (entries: readonly ContentsItem[]): ReactElement => <ul className="m-0 list-none space-y-1 border-l border-line pl-3">
    {entries.map((item) => <li key={item.id}>
      <a className="block py-0.5 text-secondary hover:text-ink hover:underline focus-visible:outline focus-visible:outline-ink" href={`#${item.id}`} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (onNavigate !== undefined) onNavigate(item.id);
        else document.getElementById(item.id)?.scrollIntoView({ block: 'start' });
      }}>{item.label}</a>
      {item.children !== undefined && item.children.length > 0 && list(item.children)}
    </li>)}
  </ul>;
  return <nav aria-label={title} className={cn('text-small', className)}>
    <p className="mb-3 mt-0 font-medium text-ink">{title}</p>
    {list(items)}
  </nav>;
}
