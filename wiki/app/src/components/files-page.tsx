/**
 * The Files page (madarch-j9ao.1.1): one template section that draws the
 * graph's files as a drillable treemap, a legend and the table of every file.
 * The page names no kind of its own: the template supplies the read, and every
 * figure is a kit chart form and every control a kit component.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { ChartLegend, ChartTreemap, type ChartNode } from './ui/charts.js';
import { SegmentedChoice } from './ui/segmented-choice.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Input } from './ui/input.js';
import { Button } from './ui/button.js';
import { entityAddress } from '../address.js';
import { formatValue } from './format.js';
import { FieldLabel, Form, Paragraph, SectionTitle, Stack, Text, TextLink } from './ui/typography.js';
import { ChoiceSelect } from './ui/choice-select.js';
import type { SectionContext } from './types.js';
import {
  colourNodes, folderLevel, heatOf, languagesOf, languageColour, measureOf, tableRows, totalsOf, WINDOWS,
  type FilesArea, type FilesColour, type FilesPageData, type FilesTableQuery, type FilesWindow,
} from './files-page-data.js';

type Sort = FilesTableQuery['sort'];

const AREA_OPTIONS: readonly { value: FilesArea; label: string; testId: string }[] = [
  { value: 'lines', label: 'lines', testId: 'files-area-lines' },
  { value: 'bytes', label: 'bytes', testId: 'files-area-bytes' },
];
const COLOUR_OPTIONS: readonly { value: FilesColour; label: string; testId: string }[] = [
  { value: 'language', label: 'language', testId: 'files-colour-language' },
  { value: 'heat', label: 'heat', testId: 'files-colour-heat' },
  { value: 'age', label: 'age', testId: 'files-colour-age' },
  { value: 'authors', label: 'authors', testId: 'files-colour-authors' },
];

/** One page of the Files kind, fed by the section's `filesPage` query. */
export function FilesPageSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const data = (context.data ?? { files: [] }) as FilesPageData;
  const compact = context.section.params['compact'] === true;
  const files = Array.isArray(data.files) ? data.files.map((file) => ({
    ...file,
    id: file.id ?? `${file.repository}/${file.path}`,
    node: file.node ?? '',
    href: file.href ?? (file.kind === undefined || file.node === undefined ? '' : entityAddress(file.kind, file.node)),
    candidates: file.candidates ?? (file.language === null ? [] : [file.language]),
  })) : [];
  const now = useMemo(() => Date.now(), [files]);
  const [area, setArea] = useState<FilesArea>('lines');
  const [colour, setColour] = useState<FilesColour>('language');
  const [window, setWindow] = useState<FilesWindow>('90d');
  const [repository, setRepository] = useState('');
  const [folder, setFolder] = useState('');
  const [pathText, setPathText] = useState('');
  const [languageFilter, setLanguageFilter] = useState('__all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<Sort>('path');
  const [ascending, setAscending] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [before, setBefore] = useState<(string | null)[]>([]);

  const totals = totalsOf(files);
  const languages = useMemo(() => languagesOf(files), [files]);
  const repositories = useMemo(() => [...new Set(files.map((file) => file.repository))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0), [files]);
  const languageOrder = languages.filter((name) => name !== '__other');
  const scope = repository === '' ? null : { repository, path: folder };
  const level = useMemo(() => folderLevel(files, scope, area), [files, scope, area]);
  const nodes = useMemo(() => colourNodes(level, files, colour, window, now, languageOrder), [level, files, colour, window, now, languageOrder]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const labelOfLanguage = (name: string): string => name === '__other' ? t('files.other') : name;

  const chartNodes: ChartNode[] = nodes.map((node) => ({
    label: node.label,
    value: node.value,
    id: node.id,
    color: node.colour ?? 'var(--surface-soft)',
    ...(node.kind === 'file' ? {} : { note: `${String(node.files)} ${t('files.filesShort')}` }),
  }));

  const languageOptions = ['__all', ...languages];
  const query: FilesTableQuery = {
    text: pathText,
    language: languageFilter,
    measure: colour === 'language' ? 'heat' : colour,
    window,
    from,
    to,
    sort,
    ascending,
    cursor,
  };
  const page = tableRows(files, query, now, 50);
  const resetPage = (): void => { setCursor(null); setBefore([]); };
  const jump = (next: string | null, back: boolean): void => {
    setBefore((held) => back ? held.slice(0, -1) : [...held, cursor]);
    setCursor(next);
  };

  const choose = (kind: 'area' | 'colour', value: string): void => {
    if (kind === 'area') setArea(value as FilesArea);
    else setColour(value as FilesColour);
    resetPage();
  };
  const chooseRepository = (value: string): void => {
    setRepository(value === '__all' ? '' : value);
    setFolder('');
    resetPage();
  };
  const clickMap = (clicked: ChartNode): void => {
    const node = byId.get(clicked.id ?? '');
    if (node === undefined) return;
    if (node.kind === 'repository') { setRepository(node.repository); setFolder(''); resetPage(); return; }
    if (node.kind === 'folder') { setFolder(node.path); resetPage(); return; }
    if (node.href !== undefined) context.open(context.base + node.href);
  };

  const header = (key: Sort, label: string): ReactElement => (
    <Button
      variant="ghost"
      size="sm"
      className="dg-sort"
      data-testid={`files-sort-${key}`}
      aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : undefined}
      onClick={() => { setSort(key); setAscending(sort === key ? !ascending : true); resetPage(); }}
    >
      {label}{sort === key ? (ascending ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />) : null}
    </Button>
  );

  const heatWindow = t(`files.window.${window}`);
  const rampMax = Math.max(1, ...files.map((file) => measureOf(file, colour === 'language' ? 'heat' : colour, window, now) ?? 0));

  if (compact) {
    return (
      <Stack className="files-page files-page-compact" data-testid="files-page">
        <Paragraph className="dg-totals" data-testid="files-totals">
          {t('files.total', { files: formatValue(totals.files, 'number', language), lines: formatValue(totals.lines, 'number', language), languages: formatValue(totals.languages, 'number', language) })}
        </Paragraph>
        <Stack className="dg-chart" data-testid="files-map">
          <ChartTreemap title={t('files.mapTitle')} nodes={chartNodes} height={260} onNodeClick={clickMap} note={t('files.noFiles')} />
        </Stack>
        <ChartLegend
          testId="files-legend"
          caption={t('files.legend')}
          items={colour === 'language' ? languages.map((name) => ({ label: labelOfLanguage(name), color: languageColour(name === '__other' ? null : name, languageOrder) })) : undefined}
          ramp={colour === 'language' ? undefined : { from: 'var(--heat-step-1)', to: 'var(--heat-step-4)', low: `0 ${colour === 'age' ? t('files.days') : colour === 'authors' ? t('files.authors') : heatWindow}`, high: formatValue(rampMax, 'number', language) }}
        />
      </Stack>
    );
  }

  return (
    <Stack className="files-page" data-testid="files-page">
      <Paragraph className="dg-totals" data-testid="files-totals">
        {t('files.total', { files: formatValue(totals.files, 'number', language), lines: formatValue(totals.lines, 'number', language), languages: formatValue(totals.languages, 'number', language) })}
      </Paragraph>
      <Stack className="dg-files-controls">
        <SegmentedChoice label={t('files.area')} testId="files-area" value={area} options={AREA_OPTIONS.map((option) => ({ ...option, label: t(`files.${option.value}`) }))} onChange={(value) => choose('area', value)} />
        <SegmentedChoice label={t('files.colour')} testId="files-colour" value={colour} options={COLOUR_OPTIONS.map((option) => ({ ...option, label: t(`files.${option.value}`) }))} onChange={(value) => choose('colour', value)} />
        {colour !== 'heat' ? null : <SegmentedChoice label={t('files.windowLabel')} testId="files-window" value={window} options={WINDOWS.map((value) => ({ value, label: t(`files.window.${value}`), testId: `files-window-${value}` }))} onChange={(value) => { setWindow(value as FilesWindow); resetPage(); }} />}
        <FieldLabel className="dg-filter">{t('files.repository')}<ChoiceSelect value={repository === '' ? '__all' : repository} options={[{ value: '__all', label: t('files.allRepositories') }, ...repositories.map((name) => ({ value: name, label: name }))]} onChange={chooseRepository} testId="files-repository" /></FieldLabel>
      </Stack>
      <Stack className="dg-crumbs" data-testid="files-breadcrumb">
        <Button variant="ghost" size="sm" className="dg-crumb" data-current={repository === ''} onClick={() => { setRepository(''); setFolder(''); resetPage(); }}>{t('files.allFiles')}</Button>
        {repository === '' ? null : <><Text className="dg-crumb-sep">/</Text><Button variant="ghost" size="sm" className="dg-crumb" data-current={folder === ''} onClick={() => { setFolder(''); resetPage(); }}>{repository}</Button></>}
        {repository === '' || folder === '' ? null : folder.split('/').map((part, at) => {
          const path = folder.split('/').slice(0, at + 1).join('/');
          return <Text className="dg-crumb-part" key={path}><Text className="dg-crumb-sep">/</Text><Button variant="ghost" size="sm" className="dg-crumb" data-current={path === folder} onClick={() => { setFolder(path); resetPage(); }}>{part}</Button></Text>;
        })}
      </Stack>
      <Stack className="dg-chart" data-testid="files-map">
        <ChartTreemap title={t('files.mapTitle')} nodes={chartNodes} height={320} onNodeClick={clickMap} note={t('files.noFiles')} />
      </Stack>
      <ChartLegend
        testId="files-legend"
        caption={t('files.legend')}
        items={colour === 'language' ? languages.map((name) => ({ label: labelOfLanguage(name), color: languageColour(name === '__other' ? null : name, languageOrder) })) : undefined}
        ramp={colour === 'language' ? undefined : { from: 'var(--heat-step-1)', to: 'var(--heat-step-4)', low: `0 ${colour === 'age' ? t('files.days') : colour === 'authors' ? t('files.authors') : heatWindow}`, high: formatValue(rampMax, 'number', language) }}
      />
      <Form className="dg-files-filters" data-testid="files-filters" onSubmit={(event) => { event.preventDefault(); resetPage(); }}>
        <FieldLabel className="dg-filter">{t('files.path')}<Input value={pathText} onChange={(event) => { setPathText(event.target.value); resetPage(); }} placeholder={t('files.pathPlaceholder')} data-testid="files-filter-path" /></FieldLabel>
        <FieldLabel className="dg-filter">{t('files.language')}
          <ChoiceSelect value={languageFilter} options={languageOptions.map((name) => ({ value: name, label: name === '__all' ? t('files.allLanguages') : labelOfLanguage(name) }))} onChange={(value) => { setLanguageFilter(value); resetPage(); }} testId="files-filter-language" />
        </FieldLabel>
        {colour === 'language' ? null : <>
          <FieldLabel className="dg-filter">{t('files.from')}<Input type="number" value={from} onChange={(event) => { setFrom(event.target.value); resetPage(); }} data-testid="files-filter-from" /></FieldLabel>
          <FieldLabel className="dg-filter">{t('files.to')}<Input type="number" value={to} onChange={(event) => { setTo(event.target.value); resetPage(); }} data-testid="files-filter-to" /></FieldLabel>
        </>}
      </Form>
      <SectionTitle className="text-title" data-testid="files-every-file">{t('files.everyFile')}</SectionTitle>
      <Stack className="dg-files-table">
        <Table data-testid="files-table">
          <TableHeader><TableRow>
            <TableHead>{header('path', t('files.path'))}</TableHead>
            <TableHead>{header('repository', t('files.repository'))}</TableHead>
            <TableHead>{header('language', t('files.language'))}</TableHead>
            <TableHead>{header('lines', t('files.lines'))}</TableHead>
            <TableHead>{header('bytes', t('files.bytes'))}</TableHead>
            <TableHead>{header('heat', t('files.heat'))}</TableHead>
            <TableHead>{header('age', t('files.lastChange'))}</TableHead>
            <TableHead>{header('authors', t('files.authors'))}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {page.rows.length === 0 ? <TableRow><TableCell colSpan={8}>{t('files.noFiles')}</TableCell></TableRow> : page.rows.map((row) => (
              <TableRow key={row.file.id} data-testid="files-row">
                <TableCell><TextLink className="dg-linkbutton" href={context.base + row.file.href} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); context.open(context.base + row.file.href); } }}>{row.file.path}</TextLink></TableCell>
                <TableCell>{row.file.repository}</TableCell>
                <TableCell>{row.file.language ?? t('files.other')}</TableCell>
                <TableCell>{row.file.lines === null ? '—' : formatValue(row.file.lines, 'number', language)}</TableCell>
                <TableCell>{row.file.bytes === null ? '—' : formatValue(row.file.bytes, 'bytes', language)}</TableCell>
                <TableCell>{formatValue(heatOf(row.file, window), 'number', language)}</TableCell>
                <TableCell>{row.file.lastChange === null ? '—' : formatValue(row.file.lastChange, 'date', language)}</TableCell>
                <TableCell>{formatValue(row.file.authorCount, 'number', language)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Stack>
      <Stack className="dg-files-pager" data-testid="files-pager">
        <Button variant="ghost" size="sm" disabled={before.length === 0} onClick={() => jump(before[before.length - 1] ?? null, true)}>{t('files.previous')}</Button>
        <Text>{t('files.range', { from: page.total === 0 ? 0 : page.start + 1, to: Math.min(page.start + page.rows.length, page.total), total: page.total })}</Text>
        <Button variant="ghost" size="sm" disabled={!page.more} onClick={() => jump(page.rows[page.rows.length - 1]?.file.id ?? null, false)}>{t('files.next')}</Button>
      </Stack>
    </Stack>
  );
}
