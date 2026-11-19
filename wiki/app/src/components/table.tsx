/**
 * A connection as a table (decision 0036, section 7): the columns the template names, the page it asked for, and the
 * presses the page acts on — the next page and the previous one through `$<sectionId>_after`, and the filter and the
 * sort through `$<sectionId>_where` and `$<sectionId>_orderBy` when the section's query declares them. A column no row
 * holds a value for is not drawn, so a template that asks fields some of its records lack reads as the records' own
 * shape.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { FilterBar, FilterField, PaginationBar, PaginationSummary } from './ui/filter-bar.js';
import { Input } from './ui/input.js';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Paragraph, TextLink } from './ui/typography.js';
import { at, dateOf, formatValue, hostOf, localized } from './format.js';
import { CommitLine, isCommit, type CommitNode } from './commit.js';
import { edgesOf, entityHref, nextOf, totalOf } from './connection.js';
import { follow } from './relations.js';
import { isFieldFormat } from '../../../../src/page-contract/schema.js';
import type { SectionContext } from './types.js';

interface Column {
  readonly label?: unknown;
  readonly path?: unknown;
  readonly format?: unknown;
  readonly sortField?: unknown;
}

interface FilterFieldDecl {
  readonly label?: unknown;
  readonly field?: unknown;
  readonly operator?: unknown;
}

/** One facet a template declares: the field its counts group by, and the path its groups arrive at. */
interface FacetDecl {
  readonly label?: unknown;
  readonly field?: unknown;
  readonly path?: unknown;
}

/**
 * The where a search text asks for (madarch-64o5.128): the field's contains, merged into the filters the reader already
 * chose, and removed again when the text is cleared.
 */
export function searchWhere(where: Readonly<Record<string, unknown>>, field: string, text: string): Record<string, unknown> {
  const next = { ...where };
  if (text === '') delete next[field];
  else next[field] = { _contains: text };
  return next;
}

/** The columns a template lets a reader sort by. */
function sortableOf(columns: readonly Column[]): readonly Column[] {
  return columns.filter((column) => typeof column.sortField === 'string');
}

/** Whether the section's query reads one of the paging variables the page supplies. */
function reads(section: SectionContext['section'], name: string): boolean {
  return (section.query ?? '').includes(`$${name}`);
}

export function TableSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const { section, data, language } = context;
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const connection = at(data, section.params['path']);
  const total = totalOf(connection);
  const rows = edgesOf(connection);
  const next = nextOf(connection);
  const declared = (Array.isArray(section.params['columns']) ? section.params['columns'] : []) as Column[];
  // A column every row leaves empty is not this list's shape: the template asks the fields its records may hold.
  const columns = rows.length === 0 ? declared : declared.filter((column) => rows.some((row) => {
    const value = at(row, column.path);
    return value !== null && value !== undefined && value !== '';
  }));
  const filters = (Array.isArray(section.params['filterFields']) ? section.params['filterFields'] : []) as FilterFieldDecl[];
  const facets = (Array.isArray(section.params['facets']) ? section.params['facets'] : []) as FacetDecl[];
  const searchField = typeof section.params['searchField'] === 'string' ? section.params['searchField'] : (filters[0] === undefined ? '' : String(filters[0].field ?? ''));
  // The where the page holds: one entry per filter (the search text and each facet's chosen value), merged so a search
  // and a facet narrow each other (madarch-64o5.128).
  const [where, setWhere] = useState<Record<string, unknown>>({});
  const [filterText, setFilterText] = useState('');
  const [sortField, setSortField] = useState('');
  const [sortDirection, setSortDirection] = useState<'ASC' | 'DESC'>('ASC');
  // The search asks the server once the reader stops typing, so one word costs one query, not one per letter; the
  // first draw asks nothing, since the page already holds the unfiltered rows.
  const lastAsked = useRef('');
  useEffect(() => {
    if (!canFilter || searchField === '' || filterText === lastAsked.current) return;
    const timer = setTimeout(() => { lastAsked.current = filterText; askText(filterText); }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterText]);
  const canPage = reads(section, `${section.id}_after`);
  const canFilter = (filters.length > 0 || facets.length > 0) && reads(section, `${section.id}_where`);
  const canSort = sortableOf(columns).length > 0 && reads(section, `${section.id}_orderBy`);

  const askPage = (cursor: string | undefined, at2: number): void => {
    const variables: Record<string, unknown> = {};
    if (canPage) variables[`${section.id}_after`] = cursor ?? null;
    context.reload(variables);
    setPage(at2);
    setCursors((held) => (at2 === 0 ? [undefined] : [...held.slice(0, at2), cursor]));
  };
  /** Asks the server for one where, as one page of the same section: the total and the rows are the server's. */
  const askWhere = (next: Record<string, unknown>): void => {
    if (!canFilter) return;
    setWhere(next);
    context.reload({ [`${section.id}_where`]: Object.keys(next).length === 0 ? null : next });
    setPage(0);
    setCursors([undefined]);
  };
  const askText = (text: string): void => {
    if (!canFilter || searchField === '') return;
    askWhere(searchWhere(where, searchField, text));
  };
  const askSort = (field: string): void => {
    if (!canSort) return;
    const direction = field === sortField && sortDirection === 'ASC' ? 'DESC' : 'ASC';
    setSortField(field);
    setSortDirection(direction);
    context.reload({ [`${section.id}_orderBy`]: field === '' ? null : [{ field, direction }] });
    setPage(0);
    setCursors([undefined]);
  };

  const body: ReactNode[][] = rows.map((row) => {
    const node = (row['node'] ?? row) as Record<string, unknown>;
    const href = entityHref(node);
    return columns.map((column, index) => {
      const value = at(row, column.path);
      const format = isFieldFormat(column.format) ? column.format : 'text';
      if (format === 'commit' && isCommit(value)) {
        return <CommitLine commit={value as CommitNode} base={context.base} open={context.open} language={language} withDate={false} withAuthor={false} />;
      }
      if (format === 'links') {
        const linked = edgesOf(value);
        const more = nextOf(value);
        return <>
          {linked.map((edge, at2) => {
            const target = (edge['node'] ?? edge) as Record<string, unknown>;
            const address = entityHref(target);
            const label = String(target['label'] ?? '');
            return <TextLink key={String(target['id'] ?? at2)} href={address === undefined ? undefined : context.base + address} {...(address === undefined ? {} : follow(context.open, context.base + address))}>{label}{at2 + 1 < linked.length ? ', ' : ''}</TextLink>;
          })}
          {more.hasNext ? <Paragraph>{t('knowledge.tableMoreRelations', { shown: linked.length, total: totalOf(value) })}</Paragraph> : null}
        </>;
      }
      if (format === 'repository') {
        const url = typeof value === 'string' ? value : '';
        return url === '' ? t('knowledge.productRepository') : hostOf(url);
      }
      const written = format === 'date'
        ? (dateOf(value, language) ?? '')
        : Array.isArray(value) ? value.map((one) => formatValue(one, format, language)).join(', ') : formatValue(value, format, language);
      // The first column of a row that is an entity reads as the link to it: a list is where a reader goes next.
      return index === 0 && href !== undefined ? <TextLink href={context.base + href} {...follow(context.open, context.base + href)}>{written}</TextLink> : written;
    });
  });
  // The rows each visited page held: a template may ask `first: 20` while the component's own default is 50, so the
  // summary counts what the connection answered rather than what a parameter guessed.
  const [sizes, setSizes] = useState<number[]>([]);
  useEffect(() => {
    setSizes((held) => {
      if (held[page] === rows.length) return held;
      const next = [...held];
      next[page] = rows.length;
      return next;
    });
  }, [page, rows.length]);
  const before = sizes.slice(0, page).reduce((sum, size) => sum + (size ?? 0), 0);
  // The connection's own paging state decides: a page before this one or a next page makes a pager.
  const paged = canPage && (page > 0 || next.hasNext);

  return (
    <>
      {canFilter ? (
        <FilterBar>
          {searchField === '' ? null : (
            <FilterField>
              {localized(filters[0]?.label, language) ?? t('knowledge.tableSearch')}
              <Input value={filterText} type="search" aria-label={t('knowledge.tableSearch')} placeholder={t('knowledge.tableSearch')} onChange={(event) => { setFilterText(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter') askText(filterText); }} data-testid="table-search" />
            </FilterField>
          )}
          {searchField === '' ? null : (
            <Button variant="default" size="sm" onClick={() => askText(filterText)} data-testid="table-find">{t('knowledge.tableFind')}</Button>
          )}
          {Object.keys(where).length === 0 ? null : <Button variant="default" size="sm" onClick={() => { setFilterText(''); askWhere({}); }} data-testid="table-clear">{t('knowledge.tableClear')}</Button>}

        </FilterBar>
      ) : null}
      {facets.map((facet, index) => {
        const field = typeof facet.field === 'string' ? facet.field : '';
        const groups = at(data, facet.path) as readonly { readonly key?: unknown; readonly count?: unknown }[] | undefined;
        if (field === '' || groups === undefined) return null;
        const active = where[field] as { _eq?: unknown } | undefined;
        return (
          <FilterBar key={String(index)} data-testid={`table-facet-${field}`}>
            <FilterField>{localized(facet.label, language) ?? field}</FilterField>
            {groups.map((group, at2) => {
              const value = group.key;
              const pressed = active?._eq === value;
              return (
                <Button key={String(at2)} variant={pressed ? 'default' : 'ghost'} size="sm" aria-pressed={pressed} data-testid={`table-facet-${field}-${String(value)}`} onClick={() => {
                  const next = { ...where };
                  if (pressed) delete next[field];
                  else next[field] = { _eq: value };
                  askWhere(next);
                }}>{`${formatValue(value, 'text', language)} (${new Intl.NumberFormat(language).format(Number(group.count ?? 0))})`}</Button>
              );
            })}
          </FilterBar>
        );
      })}
      {rows.length === 0 ? <Paragraph data-testid="table-empty">{localized(section.params['emptyText'], language) ?? t('knowledge.tableEmpty')}</Paragraph> : (
        <Table data-testid="table">
          <TableHeader>
            <TableRow>{columns.map((column, index) => {
              const field = typeof column.sortField === 'string' ? column.sortField : '';
              const label = localized(column.label, language) ?? '';
              return (
                <TableHead key={String(index)} aria-sort={canSort && field !== '' && field === sortField ? (sortDirection === 'ASC' ? 'ascending' : 'descending') : undefined}>
                  {canSort && field !== '' ? <Button variant="ghost" size="sm" onClick={() => askSort(field)} data-testid={`table-sort-${field}`}>{label}</Button> : label}
                </TableHead>
              );
            })}</TableRow>
          </TableHeader>
          <TableBody>
            {body.map((cells, index) => {
              const anchor = at(rows[index], section.params['rowAnchorPath']);
              const id = typeof anchor === 'string' ? `${String(section.params['rowAnchorPrefix'] ?? '')}${anchor}` : undefined;
              return <TableRow key={String(index)} id={id}>{cells.map((cell, at2) => <TableCell key={String(at2)}>{cell}</TableCell>)}</TableRow>;
            })}
          </TableBody>
        </Table>
      )}
      {rows.length === 0 || !paged ? null : (
        <PaginationBar>
          <PaginationSummary>{`${String(before + 1)}–${String(before + rows.length)} / ${new Intl.NumberFormat(language).format(total)}`}</PaginationSummary>
          {canPage ? (
            <>
              <Button size="icon-sm" aria-label={t('knowledge.previousPage')} disabled={page === 0 || context.busy} onClick={() => { askPage(cursors[page - 1], page - 1); }}>{t('common.previousSymbol')}</Button>
              <Button size="icon-sm" aria-label={t('knowledge.nextPage')} disabled={!next.hasNext || context.busy} onClick={() => { askPage(next.cursor, page + 1); }}>{t('common.nextSymbol')}</Button>
            </>
          ) : null}
        </PaginationBar>
      )}
    </>
  );
}
