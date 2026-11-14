import { useEffect, useId, useLayoutEffect, useState, type ReactElement } from 'react';
import { Button } from './button.js';
import { ContentsSidebar, Stack } from './typography.js';
import { cn } from '@/lib/utils.js';

export interface ContentsItem {
  id: string;
  label: string;
  children?: readonly ContentsItem[];
}

/** In-page navigation; a caller may mount a different view before scrolling. */
export function TableOfContents({ title, items, onNavigate, activeId, className }: {
  title: string;
  items: readonly ContentsItem[];
  onNavigate?: (id: string) => void;
  activeId?: string;
  className?: string;
}): ReactElement {
  const list = (entries: readonly ContentsItem[]): ReactElement => <ul className="m-0 list-none space-y-1 border-l border-line pl-3">
    {entries.map((item) => <li key={item.id}>
      <a aria-current={activeId === item.id ? 'location' : undefined} className={cn("block py-0.5 hover:underline focus-visible:outline focus-visible:outline-ink", activeId === item.id ? "font-medium text-ink" : "text-secondary hover:text-ink")} href={`#${item.id}`} onClick={(event) => {
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

/** One responsive contents control; both presentations share destinations and reading state. */
export function ResponsiveContents({ title, items }: {
  title: string;
  items: readonly ContentsItem[];
}): ReactElement {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const [destination, setDestination] = useState<string>();
  useLayoutEffect(() => {
    if (destination === undefined) return;
    document.getElementById(destination)?.scrollIntoView({ block: 'start' });
    setDestination(undefined);
  }, [destination]);
  const ids = items.flatMap((item) => [item.id, ...(item.children ?? []).map((child) => child.id)]).join(' ');
  useEffect(() => {
    const targets = ids.split(' ').filter(Boolean).map((id) => document.getElementById(id)).filter((node): node is HTMLElement => node !== null);
    if (targets.length === 0) {
      setActiveId(undefined);
      return;
    }
    let scroller = targets[0]!.parentElement;
    while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const update = () => {
      const readingTop = (scroller?.getBoundingClientRect().top ?? 0) + 16;
      let current = targets[0]!;
      for (const target of targets) {
        if (target.getBoundingClientRect().top > readingTop) break;
        current = target;
      }
      setActiveId(current.id);
    };
    update();
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [ids]);
  const navigate = (id: string) => {
    setDestination(id);
    setActiveId(id);
    setOpen(false);
  };
  const contents = <TableOfContents title={title} items={items} activeId={activeId} onNavigate={navigate} />;
  return <>
    <Stack className="order-first wide:hidden">
      <Button variant="default" size="default" aria-label={title} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>{title}</Button>
      {open && <Stack id={panelId} className="mt-3" data-testid="catalogue-compact-contents">{contents}</Stack>}
    </Stack>
    <ContentsSidebar data-testid="catalogue-contents">{contents}</ContentsSidebar>
  </>;
}
