/**
 * A connection as a table (decision 0036, section 7): the columns the template names, the page it asked for, and the
 * presses the page acts on — the next page and the previous one through `$<sectionId>_after`, and the filter and the
 * sort through `$<sectionId>_where` and `$<sectionId>_orderBy` when the section's query declares them. A column no row
 * holds a value for is not drawn, so a template that asks fields some of its records lack reads as the records' own
 * shape.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { FilterBar, FilterField, PaginationBar, PaginationSummary } from './ui/filter-bar.js';
import { Input } from './ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, UNSORTED } from './ui/select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Paragraph, TextLink } from './ui/typography.js';
import { at, dateOf, formatValue, hostOf, localized } from './format.js';
import { CommitLine, isCommit, type CommitNode } from './commit.js';
import { edgesOf, entityHref, nextOf, totalOf } from './connection.js';
import { follow } from './relations.js';
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
  const [filterField, setFilterField] = useState(filters[0] === undefined ? '' : String(filters[0].field ?? ''));
  const [filterText, setFilterText] = useState('');
  const sortable = columns.filter((column) => typeof column.sortField === 'string');
  const [sort, setSort] = useState(sortable[0] === undefined ? '' : String(sortable[0].sortField));
  const canPage = reads(section, `${section.id}_after`);
  const canFilter = filters.length > 0 && reads(section, `${section.id}_where`);
  const canSort = sortable.length > 0 && reads(section, `${section.id}_orderBy`);

  const askPage = (cursor: string | undefined, at2: number): void => {
    const variables: Record<string, unknown> = {};
    if (canPage) variables[`${section.id}_after`] = cursor ?? null;
    context.reload(variables);
    setPage(at2);
    setCursors((held) => (at2 === 0 ? [undefined] : [...held.slice(0, at2), cursor]));
  };
  const askFilter = (text: string, field: string): void => {
    if (!canFilter) return;
    const where = text === '' ? null : { [field]: { _contains: text } };
    context.reload({ [`${section.id}_where`]: where });
    setPage(0);
    setCursors([undefined]);
  };
  const askSort = (field: string): void => {
    if (!canSort) return;
    context.reload({ [`${section.id}_orderBy`]: field === '' ? null : [{ field, direction: 'ASC' }] });
    setPage(0);
    setCursors([undefined]);
  };

  const body: ReactNode[][] = rows.map((row) => {
    const node = (row['node'] ?? row) as Record<string, unknown>;
    const href = entityHref(node);
    return columns.map((column, index) => {
      const value = at(row, column.path);
      const format = typeof column.format === 'string' ? column.format : 'text';
      if (format === 'commit' && isCommit(value)) {
        return <CommitLine commit={value as CommitNode} base={context.base} open={context.open} language={language} withDate={false} withAuthor={false} />;
      }
      if (format === 'repository') {
        const url = typeof value === 'string' ? value : '';
        return url === '' ? t('knowledge.productRepository') : hostOf(url);
      }
      const written = format === 'date'
        ? (dateOf(value, language) ?? '')
        : Array.isArray(value) ? value.map((one) => formatValue(one, format, language)).join(', ') : formatValue(value, format, language);
      // The first column of a row that is an entity reads as the link to it: a list is where a reader goes next.
      return index === 0 && href !== undefined ? <TextLink href={context.base + href} onClick={follow(context.open, context.base + href)}>{written}</TextLink> : written;
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
  const firstLabel = localized(filters[0]?.label, language) ?? '';
  return (
    <>
      {canFilter || canSort ? (
        <FilterBar>
          {canFilter ? (
            <FilterField>
              {firstLabel}
              <Input value={filterText} aria-label={firstLabel === '' ? t('knowledge.tableFilter') : firstLabel} onChange={(event) => { setFilterText(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter') askFilter(filterText, filterField); }} />
            </FilterField>
          ) : null}
          {canFilter && filters.length > 1 ? (
            <FilterField>
              {t('knowledge.tableField')}
              <Select value={filterField} onValueChange={setFilterField}>
                <SelectTrigger aria-label={t('knowledge.tableField')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {filters.map((one) => {
                    const value = String(one.field ?? '');
                    return <SelectItem key={value} value={value}>{localized(one.label, language) ?? value}</SelectItem>;
                  })}
                </SelectContent>
              </Select>
            </FilterField>
          ) : null}
          {canFilter ? <Button variant="default" size="sm" onClick={() => { askFilter(filterText, filterField); }}>{t('knowledge.tableFilter')}</Button> : null}
          {canSort ? (
            <FilterField>
              {t('knowledge.tableSort')}
              <Select value={sort === '' ? UNSORTED : sort} onValueChange={(next) => { const field = next === UNSORTED ? '' : next; setSort(field); askSort(field); }}>
                <SelectTrigger aria-label={t('knowledge.tableSort')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSORTED}>—</SelectItem>
                  {sortable.map((column) => <SelectItem key={String(column.sortField)} value={String(column.sortField)}>{localized(column.label, language) ?? String(column.sortField)}</SelectItem>)}
                </SelectContent>
              </Select>
            </FilterField>
          ) : null}
        </FilterBar>
      ) : null}
      {rows.length === 0 ? <Paragraph data-testid="table-empty">{localized(section.params['emptyText'], language) ?? t('knowledge.tableEmpty')}</Paragraph> : (
        <Table data-testid="table">
          <TableHeader>
            <TableRow>{columns.map((column, index) => <TableHead key={String(index)}>{localized(column.label, language) ?? ''}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {body.map((cells, index) => <TableRow key={String(index)}>{cells.map((cell, at2) => <TableCell key={String(at2)}>{cell}</TableCell>)}</TableRow>)}
          </TableBody>
        </Table>
      )}
      {rows.length === 0 || !paged ? null : (
        <PaginationBar>
          <PaginationSummary>{`${String(before + 1)}–${String(before + rows.length)} / ${new Intl.NumberFormat(language).format(total)}`}</PaginationSummary>
          {canPage ? (
            <>
              <Button size="icon-sm" aria-label={t('knowledge.previousPage')} disabled={page === 0 || context.busy} onClick={() => { askPage(cursors[page - 1], page - 1); }}>←</Button>
              <Button size="icon-sm" aria-label={t('knowledge.nextPage')} disabled={!next.hasNext || context.busy} onClick={() => { askPage(next.cursor, page + 1); }}>→</Button>
            </>
          ) : null}
        </PaginationBar>
      )}
    </>
  );
}
