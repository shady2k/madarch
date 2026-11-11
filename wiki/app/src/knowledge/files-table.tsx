/**
 * The file table below the map (madarch-j9ao.1): every file the map drew, as a
 * row — its path, language, lines, bytes, heat, last change and authors. The
 * reader filters by path text, by language and by a range of the measure the
 * colour stands for, sorts by any column, and pages by a key cursor: a page starts
 * after the graph key of the row the last page ended on, so a file that stands
 * between pages never makes a row repeat or vanish.
 *
 * Every row opens the file's entity page; nothing here reads anything but the
 * block's own graph read.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Table, TableColumn, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { Input } from '@/components/ui/input.js';
import { Button } from '@/components/ui/button.js';
import { KLink } from './blocks.js';
import type { Block, FilesMapColour, FilesMapFile, FilesMapWindow } from './types.js';
import { bytesText, countText, drawnLanguage, heatOf, languageSources, languageWords, measureOf, WINDOWS } from './files-measure.js';

type FilesBlock = Extract<Block, { type: 'files' }>;

/** The columns a reader may sort by. */
type SortKey = 'path' | 'language' | 'lines' | 'bytes' | 'heat' | 'last' | 'authors';

/** The measures a table ranges over. */
const MEASURES: readonly Exclude<FilesMapColour, 'language'>[] = ['heat', 'age', 'authors'];

/** One row of the table, with the value its column sorts by. */
export interface FileTableRow {
  file: FilesMapFile;
  value: number | string | null;
}

/** What the reader asked of the table: its filters, its order and the key the page starts after. */
export interface TableQuery {
  text: string;
  language: string;
  measure: Exclude<FilesMapColour, 'language'>;
  window: FilesMapWindow;
  from: string;
  to: string;
  sort: SortKey;
  ascending: boolean;
  /** The graph key of the row the page starts after; null at the first page. */
  cursor: string | null;
}

/** One row's value in a column, ordered as the column reads: a file with no count sorts last, never as 0. */
function sortValue(file: FilesMapFile, key: SortKey, window: FilesMapWindow): number | string | null {
  switch (key) {
    case 'path': return file.path;
    case 'language': return drawnLanguage(file);
    case 'lines': return file.lines;
    case 'bytes': return file.bytes;
    case 'heat': return heatOf(file, window);
    case 'last': return file.last === null ? null : Date.parse(file.last);
    case 'authors': return file.authors.length;
  }
}

/** The order of two rows, code point for texts and never locale for paths. */
function compare(left: FileTableRow, right: FileTableRow): number {
  if (left.value === null && right.value === null) return 0;
  if (left.value === null) return 1;
  if (right.value === null) return -1;
  if (typeof left.value === 'string' && typeof right.value === 'string') return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  return Number(left.value) - Number(right.value);
}

/** The date a row's last change stands at, in the reader's language. */
function dateText(value: string | null, language: string): string {
  if (value === null) return '—';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value.slice(0, 10);
  return new Date(at).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The rows the table shows: filtered by path text, language and a range of the
 * measure, ordered by the column the reader chose, and cut from the graph key of
 * the row the page behind this one ended on. A file that stands between two pages
 * therefore never makes a row repeat or vanish; the value of a column and the
 * path break a tie, so the order is total.
 */
export function tableRows(files: readonly FilesMapFile[], query: TableQuery, now: number, pageSize: number): { rows: FileTableRow[]; total: number; start: number; more: boolean } {
  const text = query.text.trim().toLowerCase();
  const low = query.from === '' ? null : Number(query.from);
  const high = query.to === '' ? null : Number(query.to);
  const matching = files
    .filter((file) => {
      if (text !== '' && !file.path.toLowerCase().includes(text)) return false;
      if (query.language === '__other' ? drawnLanguage(file) !== null : query.language !== '' && (drawnLanguage(file) ?? '') !== query.language) return false;
      if (low !== null || high !== null) {
        const value = measureOf(file, query.measure, query.window, now);
        if (value === null) return false;
        if (low !== null && value < low) return false;
        if (high !== null && value > high) return false;
      }
      return true;
    })
    .map((file): FileTableRow => ({ file, value: sortValue(file, query.sort, query.window) }));
  const ordered = [...matching].sort((left, right) => {
    // A file with no value in the column stands last whichever way the column is read, never first as a "zero".
    const order = compare(left, right);
    if (left.value === null || right.value === null) return order;
    return (order || (left.file.path < right.file.path ? -1 : left.file.path > right.file.path ? 1 : 0)) * (query.ascending ? 1 : -1);
  });
  const at = query.cursor === null ? -1 : ordered.findIndex((row) => row.file.id === query.cursor);
  const start = at < 0 ? 0 : at + 1;
  return { rows: ordered.slice(start, start + pageSize), total: ordered.length, start, more: start + pageSize < ordered.length };
}

export function FilesTableView({ block }: { block: FilesBlock }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const now = useMemo(() => Date.now(), [block]);
  const files = block.data.files;
  const [query, setQuery] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');
  const [measure, setMeasure] = useState<Exclude<FilesMapColour, 'language'>>(block.colour === 'language' ? 'heat' : block.colour);
  const [window, setWindow] = useState<FilesMapWindow>(block.window);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<SortKey>('path');
  const [ascending, setAscending] = useState(true);
  /** The key of the row the page starts after: the graph key of the last row of the page behind it. */
  const [cursor, setCursor] = useState<string | null>(null);
  const [before, setBefore] = useState<(string | null)[]>([]);

  const languages = useMemo(() => {
    const names = new Set<string>();
    for (const file of files) {
      const drawn = drawnLanguage(file);
      if (drawn !== null) names.add(drawn);
    }
    return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }, [files]);
  const maxOfMeasure = useMemo(() => {
    let max = 0;
    for (const file of files) {
      const value = measureOf(file, measure, window, now);
      if (value !== null && value > max) max = value;
    }
    return max;
  }, [files, measure, window, now]);

  const shown = useMemo(() => tableRows(files, { text: query, language: languageFilter, measure, window, from, to, sort, ascending, cursor }, now, block.pageSize), [files, query, languageFilter, measure, window, from, to, sort, ascending, cursor, now, block.pageSize]);
  const { rows: page, total, start, more } = shown;

  const jump = (next: string | null, back: boolean): void => {
    setBefore(back ? (held) => held.slice(0, -1) : (held) => [...held, cursor]);
    setCursor(next);
  };
  const reset = (): void => {
    setCursor(null);
    setBefore([]);
  };

  const header = (key: SortKey, label: string, numeric = false): ReactElement => (
    <TableHead className={numeric ? 'whitespace-nowrap px-2 text-right' : 'whitespace-nowrap px-2'} aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <Button
        type="button"
        size="content"
        className="whitespace-nowrap"
        data-testid={`files-sort-${key}`}
        onClick={() => {
          if (sort === key) setAscending(!ascending);
          else {
            setSort(key);
            setAscending(true);
          }
          reset();
        }}
      >
        {label}
        {sort === key && (ascending ? <ArrowUpIcon aria-hidden="true" className="size-3" /> : <ArrowDownIcon aria-hidden="true" className="size-3" />)}
      </Button>
    </TableHead>
  );

  const measured = t(`knowledge.files.colour_${measure}`);
  return (
    <section data-block="files-table" aria-label={block.title}>
      <h2>{block.title}</h2>
      <div className="dg-files-filters" data-testid="files-filters">
        <label className="dg-filter">
          <span>{t('knowledge.files.filterPath')}</span>
          <Input value={query} onChange={(event) => { setQuery(event.target.value); reset(); }} placeholder={t('knowledge.files.filterPathHint')} data-testid="files-filter-path" />
        </label>
        <label className="dg-filter">
          <span>{t('knowledge.files.colLanguage')}</span>
          <select className="dg-select" value={languageFilter} onChange={(event) => { setLanguageFilter(event.target.value); reset(); }} data-testid="files-filter-language">
            <option value="">{t('knowledge.files.anyLanguage')}</option>
            {languages.map((name) => <option key={name} value={name}>{name}</option>)}
            {files.some((file) => drawnLanguage(file) === null) && <option value="__other">{t('knowledge.files.other')}</option>}
          </select>
        </label>
        <label className="dg-filter">
          <span>{t('knowledge.files.filterMeasure')}</span>
          <select className="dg-select" value={measure} onChange={(event) => { setMeasure(event.target.value as Exclude<FilesMapColour, 'language'>); reset(); }} data-testid="files-filter-measure">
            {MEASURES.map((one) => <option key={one} value={one}>{t(`knowledge.files.colour_${one}`)}</option>)}
          </select>
        </label>
        {measure === 'heat' && (
          <label className="dg-filter">
            <span>{t('knowledge.files.windowLabel')}</span>
            <select className="dg-select" value={window} onChange={(event) => { setWindow(event.target.value as FilesMapWindow); reset(); }} data-testid="files-filter-window">
              {WINDOWS.map((one) => <option key={one} value={one}>{t(`knowledge.files.window.${one}`)}</option>)}
            </select>
          </label>
        )}
        <label className="dg-filter">
          <span>{t('knowledge.files.filterFrom', { measure: measured, max: maxOfMeasure })}</span>
          <Input type="text" inputMode="numeric" value={from} onChange={(event) => { setFrom(event.target.value); reset(); }} data-testid="files-filter-from" />
        </label>
        <label className="dg-filter">
          <span>{t('knowledge.files.filterTo')}</span>
          <Input type="text" inputMode="numeric" value={to} onChange={(event) => { setTo(event.target.value); reset(); }} data-testid="files-filter-to" />
        </label>
      </div>
      {/* Fixed columns leave the path the remaining width; the kit table contains overflow on narrow screens. */}
      <Table data-testid="files-table" layout="fixed" density="compact" className="min-w-2xl">
        <colgroup>
          <TableColumn />
          <TableColumn width="lg" />
          <TableColumn width="sm" />
          <TableColumn width="md" />
          <TableColumn width="xs" />
          <TableColumn width="xl" />
          <TableColumn width="md" />
        </colgroup>
        <TableHeader>
          <TableRow>
            {header('path', t('knowledge.files.colPath'))}
            {header('language', t('knowledge.files.colLanguage'))}
            {header('lines', t('knowledge.files.colLines'), true)}
            {header('bytes', t('knowledge.files.colBytes'), true)}
            {header('heat', t('knowledge.files.colHeat'), true)}
            {header('last', t('knowledge.files.colLast'))}
            {header('authors', t('knowledge.files.colAuthors'), true)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.map((row) => {
            const file = row.file;
            const words = languageWords(file, t('knowledge.files.other'));
            return (
              <TableRow key={file.id} data-testid="files-row" data-path={file.path}>
                <TableCell className="truncate px-2 font-mono text-small" title={file.path}>
                  {file.href === null ? file.path : <KLink href={file.href} testId="files-row-link">{file.path}</KLink>}
                </TableCell>
                <TableCell className="whitespace-nowrap px-2 text-muted" title={languageSources(file, t('knowledge.files.other')).join('\n')}>{words.length === 0 ? t('knowledge.files.other') : words.join(' · ')}</TableCell>
                <TableCell className="whitespace-nowrap px-2 text-right text-muted tabular-nums">{file.lines === null ? '—' : countText(file.lines)}</TableCell>
                <TableCell className="whitespace-nowrap px-2 text-right text-muted tabular-nums">{file.bytes === null ? '—' : bytesText(file.bytes)}</TableCell>
                <TableCell className="whitespace-nowrap px-2 text-right tabular-nums" data-testid="files-row-heat">{countText(heatOf(file, window))}</TableCell>
                <TableCell className="whitespace-nowrap px-2 text-muted tabular-nums">{dateText(file.last, language)}</TableCell>
                <TableCell className="whitespace-nowrap px-2 text-right text-muted tabular-nums" title={file.authors.join(', ')}>{file.authors.length === 0 ? '—' : countText(file.authors.length)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {page.length === 0 && <p className="text-small text-muted" data-testid="files-none">{t('knowledge.files.none')}</p>}
      <div className="dg-files-pager" data-testid="files-pager">
        <span data-testid="files-range">{t('knowledge.files.range', { from: total === 0 ? 0 : start + 1, to: start + page.length, total, all: files.length })}</span>
        <span className="dg-spacer" />
        <Button type="button" size="sm" variant="default" disabled={before.length === 0} onClick={() => jump(before[before.length - 1] ?? null, true)} data-testid="files-prev">
          <ChevronLeftIcon aria-hidden="true" className="size-4" />{t('knowledge.files.previous')}
        </Button>
        <Button type="button" size="sm" variant="default" disabled={!more} onClick={() => jump(page[page.length - 1]?.file.id ?? null, false)} data-testid="files-next">
          {t('knowledge.files.next')}<ChevronRightIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {block.notes.map((note) => <p key={note} className="text-small text-muted" data-testid="files-note">{note}</p>)}
    </section>
  );
}
