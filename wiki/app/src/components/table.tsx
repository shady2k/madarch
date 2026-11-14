/**
 * A connection as a table (decision 0036, section 7): the columns the template names, the page it asked for, and the
 * presses the page acts on — the next page and the previous one through `$<sectionId>_after`, and the filter and the
 * sort through `$<sectionId>_where` and `$<sectionId>_orderBy` when the section's query declares them.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { Table } from './ui/data.js';
import { Button, Field, Select, TextInput } from './ui/controls.js';
import { Inline, InlineMuted, Stack } from './ui/layout.js';
import { Link } from './ui/typography.js';
import { at, formatValue, localized } from './format.js';
import { edgesOf, entityHref, nextOf, totalOf } from './connection.js';
import type { SectionContext } from './types.js';

interface Column {
  readonly label?: unknown;
  readonly path?: unknown;
  readonly format?: unknown;
  readonly sortField?: unknown;
}

interface FilterField {
  readonly label?: unknown;
  readonly field?: unknown;
  readonly operator?: unknown;
}

/** Whether the section's query reads one of the paging variables the page supplies. */
function reads(section: SectionContext['section'], name: string): boolean {
  return (section.query ?? '').includes(`$${name}`);
}

export function TableSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { section, data, language } = context;
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const connection = at(data, section.params['path']);
  const total = totalOf(connection);
  const rows = edgesOf(connection);
  const next = nextOf(connection);
  const columns = (Array.isArray(section.params['columns']) ? section.params['columns'] : []) as Column[];
  const filters = (Array.isArray(section.params['filterFields']) ? section.params['filterFields'] : []) as FilterField[];
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

  const head = columns.map((column) => localized(column.label, language) ?? '');
  const body: ReactNode[][] = rows.map((edge) => {
    const node = (edge['node'] ?? {}) as Record<string, unknown>;
    const href = entityHref(node);
    return columns.map((column, index) => {
      const value = at(edge, column.path);
      const format = typeof column.format === 'string' ? column.format : 'text';
      const written = Array.isArray(value) ? value.map((one) => formatValue(one, format, language)).join(', ') : formatValue(value, format, language);
      // A row that is an entity reads as a link: a list of records is where a reader goes next.
      return index === 0 && href !== undefined ? <Link href={context.base + href} onOpen={context.open}>{written}</Link> : written;
    });
  });
  const pageSize = typeof section.params['pageSize'] === 'number' ? section.params['pageSize'] : 50;
  return (
    <Stack gap={2}>
      {canFilter || canSort ? (
        <Inline gap={2}>
          {canFilter ? (
            <Field label={localized(filters[0]?.label, language) ?? ''}>
              <TextInput value={filterText} label={localized(filters[0]?.label, language) ?? 'filter'} onInput={setFilterText} onSubmit={() => askFilter(filterText, filterField)} />
            </Field>
          ) : null}
          {canFilter && filters.length > 1 ? (
            <Field label="Field">
              <Select label="Field" value={filterField} options={filters.map((one) => ({ value: String(one.field ?? ''), label: localized(one.label, language) ?? String(one.field ?? '') }))} onChange={setFilterField} />
            </Field>
          ) : null}
          {canFilter ? <Button onClick={() => askFilter(filterText, filterField)}>Filter</Button> : null}
          {canSort ? (
            <Field label="Sort">
              <Select
                label="Sort"
                value={sort}
                options={[{ value: '', label: '—' }, ...sortable.map((column) => ({ value: String(column.sortField), label: localized(column.label, language) ?? String(column.sortField) }))]}
                onChange={(value) => { setSort(value); askSort(value); }}
              />
            </Field>
          ) : null}
        </Inline>
      ) : null}
      <Table head={head} rows={body} empty={localized(section.params['emptyText'], language) ?? '—'} />
      <Inline gap={2}>
        <InlineMuted>{`${String(rows.length === 0 ? 0 : page * pageSize + 1)}–${String(page * pageSize + rows.length)} / ${new Intl.NumberFormat(language).format(total)}`}</InlineMuted>
        {canPage ? (
          <>
            <Button disabled={page === 0 || context.busy} onClick={() => askPage(cursors[page - 1], page - 1)}>←</Button>
            <Button disabled={!next.hasNext || context.busy} onClick={() => askPage(next.cursor, page + 1)}>→</Button>
          </>
        ) : null}
      </Inline>
    </Stack>
  );
}
