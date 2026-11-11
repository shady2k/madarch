/**
 * The wiki's search in the top bar (madarch-o0d): pages and entities by title and text, grouped by kind, read from the
 * server's own search over the store the pages come from. Ctrl+K (Cmd+K on a Mac) puts the field in hand, the arrows
 * walk the rows, Enter opens one, and Escape closes the results. At a phone's width the search stands behind its icon
 * and opens over the bar, so the bar keeps its one row.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchIcon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { Input } from '@/components/ui/input.js';
import { Button } from '@/components/ui/button.js';
import { navigateTo } from '../hold.js';
import { getSearch } from './api.js';
import { useKindName } from './kind-names.js';
import type { SearchView } from './types.js';

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

export function SearchBox(): ReactElement {
  const { t, i18n } = useTranslation();
  const kindName = useKindName();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [view, setView] = useState<SearchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  // The words are asked after a pause, so a row of typing is one read of the store; an empty field asks nothing.
  useEffect(() => {
    const wait = setTimeout(() => setAsked(query.trim()), query.trim() === '' ? 0 : 200);
    return () => clearTimeout(wait);
  }, [query]);
  useEffect(() => {
    if (asked === '') {
      setView(null);
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    getSearch(asked, language, controller.signal).then(
      (answer) => {
        setView(answer);
        setError(null);
        setActive(0);
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(messageOf(failure));
        setView(null);
      },
    );
    return () => controller.abort();
  }, [asked, language]);
  // The one shortcut of the bar: Ctrl+K, or Cmd+K on a Mac, puts the field in hand from anywhere on the page.
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setOpen(true);
      field.current?.focus();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  // The phone's field appears on the icon's press, and the first thing typed should reach it.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  // A press anywhere else closes the results; the search keeps its words for the next opening.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (target !== null && box.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const groups = view?.groups ?? [];
  // The rows in reading order, so the arrows walk the groups as one list.
  const rows = groups.flatMap((group) => group.rows);
  const shown = open && query.trim() !== '';
  const activeId = rows[active] === undefined ? undefined : `${listId}-row-${active}`;
  const move = (step: number): void => {
    if (rows.length === 0) return;
    setActive((held) => (held + step + rows.length) % rows.length);
  };
  const go = (href: string): void => {
    setOpen(false);
    navigateTo(appPath(href));
  };
  let rowAt = 0;
  return (
    <div ref={box} className="shell-search" data-open={open ? 'true' : 'false'} data-testid="search-box">
      <Button
        type="button"
        className="shell-search-toggle shrink-0"
        aria-label={t('knowledge.searchLabel')}
        aria-expanded={open}
        title={t('knowledge.searchHint')}
        data-testid="search-toggle"
        onClick={() => setOpen(!open)}
      >
        <SearchIcon aria-hidden="true" className="size-5" />
      </Button>
      <Input
        ref={field}
        type="search"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown ? activeId : undefined}
        aria-label={t('knowledge.searchLabel')}
        placeholder={t('knowledge.searchPlaceholder')}
        title={t('knowledge.searchHint')}
        value={query}
        onInput={(event) => { setOpen(true); setQuery(event.currentTarget.value); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
          else if (event.key === 'Enter') {
            const row = rows[active];
            if (row !== undefined) { event.preventDefault(); go(row.href); }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            if (shown) setOpen(false);
            else { setOpen(false); event.currentTarget.blur(); }
          }
        }}
        className="shell-search-input max-w-[15rem]"
        data-testid="search-input"
      />
      {shown && (
        <div role="listbox" id={listId} aria-label={t('knowledge.searchResults')} className="shell-search-results absolute right-0 top-[calc(100%+6px)] z-50 max-h-[70vh] w-[min(28rem,92vw)] overflow-y-auto rounded-[var(--radius-card)] border border-line bg-page p-2 text-left shadow-lg" data-testid="search-results">
          {error !== null && <p className="m-0 p-2 text-small" role="alert" data-testid="search-error">{t('knowledge.searchFailed', { message: error })}</p>}
          {error === null && view !== null && view.total === 0 && <p className="m-0 p-2 text-small text-muted" data-testid="search-empty">{t('knowledge.searchEmpty')}</p>}
          {error === null && groups.map((group) => (
            <div key={group.kind} role="group" aria-label={kindName(group.kind, 'many')} data-testid="search-group" data-kind={group.kind}>
              <p className="mb-1 mt-2 px-2 text-[12px] uppercase tracking-[0.08em] text-muted first:mt-0">
                {kindName(group.kind, 'many')} <span className="normal-case tracking-normal" data-testid="search-group-count">{group.total}</span>
              </p>
              <ul className="m-0 list-none p-0">
                {group.rows.map((row) => {
                  const at = rowAt++;
                  return (
                    <li key={row.id}>
                      <a
                        id={`${listId}-row-${at}`}
                        role="option"
                        aria-selected={at === active}
                        href={appPath(row.href)}
                        data-testid="search-row"
                        data-active={at === active ? 'true' : undefined}
                        className={'block rounded-[var(--radius-row)] px-2 py-1.5 no-underline ' + (at === active ? 'bg-[var(--surface-active)] text-ink' : 'text-secondary hover:bg-[var(--surface-hover)] hover:text-ink')}
                        onMouseEnter={() => setActive(at)}
                        onClick={(event) => { if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return; event.preventDefault(); go(row.href); }}
                      >
                        <span className="block truncate text-small font-[550]">{row.title}</span>
                        {row.excerpt !== undefined && <span className="mt-0.5 block text-small text-muted" data-testid="search-excerpt">{row.excerpt}</span>}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
