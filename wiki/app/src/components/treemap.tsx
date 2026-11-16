/** A template connection as a folder map. Areas use only the selected graph measure; colour uses language or last-change recency. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { titleIn } from '../../../../src/page-contract/index.js';
import { Button } from './ui/button.js';
import { ChartTreemap, type ChartNode } from './ui/charts.js';
import { ColourSwatch } from './ui/drawing.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import { InlineGroup, PageSection, Paragraph, Stack, TextLink } from './ui/typography.js';
import { at, localized } from './format.js';
import { edgesOf, entityHref, nextOf } from './connection.js';
import { follow } from './relations.js';
import type { SectionContext } from './types.js';

interface Measure { readonly path: string; readonly label: unknown }
interface FileRow { readonly path: string; readonly row: Record<string, unknown>; readonly language: string; readonly changed?: number; readonly value?: number }
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const category = (index: number): string => `var(--chart-cat-${String(index % 7 + 1)})`;

export function TreemapSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const params = context.section.params;
  const connection = at(context.data, params['path']);
  const measures = (Array.isArray(params['valuePaths']) ? params['valuePaths'] : []) as Measure[];
  const [measure, setMeasure] = useState(String(params['valuePath']));
  const root = typeof params['rootPath'] === 'string' ? params['rootPath'] : '';
  const [folder, setFolder] = useState(root);
  const [colour, setColour] = useState('language');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const next = nextOf(connection);
  const canPage = (context.section.query ?? '').includes(`$${context.section.id}_after`);
  const changePage = (cursor: string | undefined, index: number): void => {
    context.reload({ [`${context.section.id}_after`]: cursor ?? null });
    setPage(index);
    setCursors((held) => index === 0 ? [undefined] : [...held.slice(0, index), cursor]);
    setFolder(root);
  };
  const [days, setDays] = useState('30');
  const [now] = useState(Date.now);
  const holder = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const measureWidth = (): void => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    measureWidth();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rows = edgesOf(connection);
  const files: FileRow[] = [];
  let missingPaths = 0;
  for (const row of rows) {
    const path = at(row, params['pathPath']);
    if (typeof path !== 'string' || path === '') { missingPaths += 1; continue; }
    const rawValue = at(row, measure);
    const rawLanguage = at(row, params['languagePath']);
    const rawChanged = at(row, params['changedPath']);
    const changed = typeof rawChanged === 'string' ? Date.parse(rawChanged) : NaN;
    files.push({ path, row, language: typeof rawLanguage === 'string' && rawLanguage !== '' ? rawLanguage : t('knowledge.treemap.unknownLanguage'),
      ...(typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0 ? { value: rawValue } : {}),
      ...(Number.isFinite(changed) ? { changed } : {}) });
  }
  files.sort((a, b) => compare(a.path, b.path));
  const under = files.filter((file) => folder === '' || file.path.startsWith(`${folder}/`));
  const languages = [...new Set(files.map((file) => file.language))].sort(compare);
  const heat = (file: FileRow): string => {
    if (file.changed === undefined || file.changed > now) return 'var(--surface-soft)';
    const age = (now - file.changed) / 86_400_000;
    if (age > Number(days)) return 'var(--surface-soft)';
    const strength = 1 - age / Number(days);
    return `color-mix(in oklab, var(--text) ${String(Math.round(22 + strength * 62))}%, var(--bg-page))`;
  };
  const leaf = (file: FileRow, label: string): ChartNode => ({ label, ...(file.value === undefined ? {} : { value: file.value }),
    color: colour === 'language' ? category(languages.indexOf(file.language)) : heat(file),
    textColor: colour === 'changed' && file.changed !== undefined && file.changed <= now && (now - file.changed) / 86_400_000 < Number(days) / 2 ? 'var(--bg-page)' : 'var(--text)' });
  const folders = new Map<string, FileRow[]>();
  const direct: FileRow[] = [];
  for (const file of under) {
    const relative = folder === '' ? file.path : file.path.slice(folder.length + 1);
    const slash = relative.indexOf('/');
    if (slash === -1) direct.push(file);
    else {
      const name = relative.slice(0, slash);
      const members = folders.get(name) ?? [];
      members.push(file); folders.set(name, members);
    }
  }
  const groups = [...folders.entries()].sort(([a], [b]) => compare(a, b));
  const nodes: ChartNode[] = [...groups.map(([name, members]) => ({ label: `${name}/`, children: members.map((file) => leaf(file, file.path)) })),
    ...direct.map((file) => leaf(file, file.path.slice(file.path.lastIndexOf('/') + 1)))];
  const segments = folder === root ? [] : folder.slice(root === '' ? 0 : root.length + 1).split('/');
  const title = titleIn(context.section.title, context.language) ?? t('knowledge.treemap.title');
  return <PageSection ref={holder} data-testid="treemap"><Stack layout="text">
    {next.hasNext || page > 0 ? <Paragraph data-testid="treemap-subset">{t('knowledge.treemap.subset', { count: rows.length })}</Paragraph> : null}
    {canPage && (next.hasNext || page > 0) ? <InlineGroup>
      <Button size="sm" disabled={page === 0 || context.busy} onClick={() => { changePage(cursors[page - 1], page - 1); }}>{t('knowledge.previousPage')}</Button>
      <Button size="sm" disabled={!next.hasNext || context.busy} onClick={() => { changePage(next.cursor, page + 1); }}>{t('knowledge.nextPage')}</Button>
      <Paragraph>{context.busy ? t('knowledge.treemap.busy') : page === 0 ? t('knowledge.treemap.firstPage') : !next.hasNext ? t('knowledge.treemap.lastPage') : t('knowledge.treemap.page', { page: page + 1 })}</Paragraph>
    </InlineGroup> : null}
    {missingPaths > 0 ? <Paragraph>{t('knowledge.treemap.missingPaths', { count: missingPaths })}</Paragraph> : null}
    <InlineGroup aria-label={t('knowledge.treemap.breadcrumb')}>
      <Button variant="ghost" size="sm" onClick={() => { setFolder(root); }}>{root || t('knowledge.treemap.root')}</Button>
      {segments.map((segment, index) => <Button key={segments.slice(0, index + 1).join('/')} variant="ghost" size="sm" onClick={() => { setFolder([root, ...segments.slice(0, index + 1)].filter(Boolean).join('/')); }}>{segment}</Button>)}
    </InlineGroup>
    <InlineGroup>
      {measures.length > 1 ? <Select value={measure} onValueChange={setMeasure}>
        <SelectTrigger aria-label={t('knowledge.treemap.measure')}><SelectValue /></SelectTrigger>
        <SelectContent>{measures.map((one) => <SelectItem key={one.path} value={one.path}>{localized(one.label, context.language)}</SelectItem>)}</SelectContent>
      </Select> : null}
      <Select value={colour} onValueChange={setColour}>
        <SelectTrigger aria-label={t('knowledge.treemap.colour')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="language">{t('knowledge.treemap.language')}</SelectItem><SelectItem value="changed">{t('knowledge.treemap.changed')}</SelectItem></SelectContent>
      </Select>
      {colour === 'changed' ? <Select value={days} onValueChange={setDays}>
        <SelectTrigger aria-label={t('knowledge.treemap.window')}><SelectValue /></SelectTrigger>
        <SelectContent>{['7', '30', '90', '365'].map((one) => <SelectItem key={one} value={one}>{t('knowledge.treemap.days', { count: Number(one) })}</SelectItem>)}</SelectContent>
      </Select> : null}
    </InlineGroup>
    <ChartTreemap title={title} nodes={nodes} note={t('knowledge.treemap.empty')} {...(width === undefined ? {} : { width })} />
    <Paragraph>{t('knowledge.treemap.navigationNote')}</Paragraph>
    {colour === 'language' ? <InlineGroup data-testid="treemap-legend" aria-label={t('knowledge.treemap.language')}>
      {[...new Set(under.map((file) => file.language))].sort(compare).map((name) => <Paragraph key={name}><ColourSwatch background={category(languages.indexOf(name))} aria-hidden="true">  </ColourSwatch> {name}</Paragraph>)}
    </InlineGroup> : <>
      <Paragraph>{t('knowledge.treemap.heatNote', { count: Number(days) })}</Paragraph>
      <Paragraph>{t('knowledge.treemap.missingChanged', { count: under.filter((file) => file.changed === undefined || file.changed > now).length })}</Paragraph>
    </>}
    <InlineGroup>{groups.map(([name]) => <Button key={name} variant="outline" size="sm" onClick={() => { setFolder(folder === '' ? name : `${folder}/${name}`); }}>{t('knowledge.treemap.folder', { path: `${name}/` })}</Button>)}</InlineGroup>
    {direct.map((file) => {
      const node = file.row['node'];
      const href = entityHref(typeof node === 'object' && node !== null ? node as Record<string, unknown> : file.row);
      return <Paragraph key={file.path}>{href === undefined ? file.path : <TextLink href={context.base + href} onClick={follow(context.open, context.base + href)}>{file.path}</TextLink>}{t('knowledge.treemap.fileValue', { value: file.value === undefined ? t('knowledge.treemap.unknownValue') : new Intl.NumberFormat(context.language).format(file.value), language: file.language })}</Paragraph>;
    })}
  </Stack></PageSection>;
}
