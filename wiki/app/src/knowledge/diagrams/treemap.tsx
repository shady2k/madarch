import { Breadcrumb } from '@/components/ui/breadcrumb.js';
import { DrawingSurface } from '@/components/ui/drawing.js';
import { ColourSwatch } from '@/components/ui/drawing.js';
import { SegmentedChoice } from '@/components/ui/segmented-choice.js';
import { Figure, FigureCaption } from '@/components/ui/figure.js';
import { Button } from '@/components/ui/button.js';
import { Paragraph, PlainList, Stack, Text } from '@/components/ui/typography.js';
/**
 * The repository map and the file table of a repository's or a folder's page
 * (madarch-j9ao.1): a drillable treemap whose area follows the lines or the bytes
 * and whose colour follows the language, the heat of a window, the age of the
 * last change or the number of authors, with a legend and the totals above it, and
 * below it the files themselves as a table, filtered, sorted and paged.
 *
 * The map is drawn by Apache ECharts by default, loaded when the map is opened,
 * and as Mermaid's own static `treemap` picture when the template or the reader
 * asks for one; both are drawn from the same cells and measures, so the picture
 * and the map always name the same files.
 */
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { Block, FilesMapColour, FilesMapEngine, FilesMapWindow } from '../types.js';
import { folderLevel, mermaidTreemap } from '../../../../../src/knowledge/files-treemap.js';
import { MermaidDiagram } from '../../diagram.js';
import { DiagramOpenContext } from './open.js';
import { Fullscreenable, fullscreenHeight, useFullscreen } from './fullscreen.js';
import { countText, drawnLanguage, heatOf, LANGUAGE_COLOURS, languageSources, linesText, maxMeasure, measureOf, RAMPS, WINDOWS, type Ramp } from '../files-measure.js';
import type { MapCell } from './files-echart.js';

const EChartsTreemap = lazy(() => import('./files-echart.js').then((module) => ({ default: module.EChartsTreemap })));

type TreemapBlock = Extract<Block, { type: 'treemap' }>;

/** The leaves a static Mermaid picture draws, as the server's own builder bounds it. */
const MERMAID_LIMIT = 250;

/** The warmth of a value between 0 and 1, as two ramp stops read by the legend's gradient. */
export function rampStyle(ramp: Ramp): string {
  return `linear-gradient(to right, ${ramp.colors.join(', ')})`;
}

/** The jumps a reader makes between measures, and the words of each in the toolbar. */
const COLOURS: readonly FilesMapColour[] = ['language', 'heat', 'age', 'authors'];

/** How a reader's colour scheme is read, live, by the map's canvas. */
function useDarkScheme(): boolean {
  const [dark, setDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (event: MediaQueryListEvent): void => setDark(event.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  return dark;
}

/** The width the map is drawn in, followed as the page changes. */
function useWidth(holder: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [holder]);
  return width;
}

/** The date a file's last change stands at, as the reader's own language writes it. */
function dateText(value: string | null, language: string): string {
  if (value === null) return '—';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value.slice(0, 10);
  return new Date(at).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The folders a reader climbed from the page's own root: the breadcrumb's segments, never the root itself. */
export function crumbSegments(root: string, folder: string): string[] {
  const inside = root === '' ? folder : folder === root ? '' : folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder;
  return inside === '' ? [] : inside.split('/');
}

export function TreemapView({ block }: { block: TreemapBlock }): ReactElement {
  return <Fullscreenable><TreemapBody block={block} /></Fullscreenable>;
}

function TreemapBody({ block }: { block: TreemapBlock }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const dark = useDarkScheme();
  const full = useFullscreen();
  const open = useContext(DiagramOpenContext);
  const holder = useRef<HTMLDivElement | null>(null);
  const width = useWidth(holder);
  const [area, setArea] = useState(block.area);
  const [colour, setColour] = useState<FilesMapColour>(block.colour);
  const [window, setWindow] = useState<FilesMapWindow>(block.window);
  const [engine, setEngine] = useState<FilesMapEngine>(block.engine);
  const [folder, setFolder] = useState(block.data.folder);
  const now = useMemo(() => Date.now(), [block]);
  const files = block.data.files;
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const compact = width > 0 && width < 560;
  const height = full ? fullscreenHeight(190) : compact ? 340 : 520;

  const counted = useMemo(() => block.data.totals.languages.map((entry) => entry.name), [block.data.totals.languages]);
  const languages = useMemo(() => counted, [counted]);
  const other = useMemo(() => files.some((file) => drawnLanguage(file) === null), [files]);
  const colours = useMemo(() => {
    const names = [...languages, ...(other ? [t('knowledge.files.other')] : [])];
    return names.map((name, index) => ({ name, color: index < languages.length ? LANGUAGE_COLOURS[index % LANGUAGE_COLOURS.length]! : (dark ? '#5a5c62' : '#b7b9be') }));
  }, [languages, other, dark, t]);
  const colourIndex = useMemo(() => new Map(colours.map((entry, index) => [entry.name, index])), [colours]);
  const ramp = (colour === 'language' ? RAMPS.heat : RAMPS[colour])[dark ? 'dark' : 'light'];
  // Heat is read on a square-root scale: most files are changed once or twice and a linear ramp would paint them all
  // the same cold colour, while one file changed a hundred times took the whole ramp (measured on madarch's own map).
  const rawMax = useMemo(() => (colour === 'language' ? 0 : maxMeasure(files, colour, window, now)), [colour, files, window, now]);
  const max = useMemo(() => (colour === 'language' ? Math.max(1, colours.length - 1) : Math.max(1, colour === 'heat' ? Math.sqrt(rawMax) : rawMax)), [colour, colours.length, rawMax]);
  const maxAuthors = useMemo(() => files.reduce((most, file) => Math.max(most, file.authors.length), 0), [files]);
  const ageOf = (file: (typeof files)[number]): number => {
    const days = measureOf(file, 'age', window, now);
    return days === null ? 0 : days;
  };
  const measureOfFile = (file: (typeof files)[number]): number => {
    if (colour === 'language') {
      const name = drawnLanguage(file) ?? t('knowledge.files.other');
      return colourIndex.get(name) ?? colours.length;
    }
    const value = measureOf(file, colour, window, now);
    if (value === null) return max + 1;
    return colour === 'heat' ? Math.sqrt(value) : value;
  };

  /** The tooltip of one file: every fact the cells' colour and the table's columns show. */
  const tipOf = (path: string): string => {
    const file = byPath.get(path);
    if (file === undefined) return path;
    return [
      file.path,
      `${t('knowledge.files.colLines')}: ${file.lines === null ? '—' : countText(file.lines)} · ${t('knowledge.files.colBytes')}: ${file.bytes === null ? '—' : countText(file.bytes)}`,
      `${t('knowledge.files.colLanguage')}: ${languageSources(file, t('knowledge.files.other')).join(' · ') || t('knowledge.files.other')}`,
      `${t('knowledge.files.colHeat')} (${t(`knowledge.files.window.${window}`)}): ${String(heatOf(file, window))}`,
      `${t('knowledge.files.colLast')}: ${dateText(file.last, language)}`,
      `${t('knowledge.files.colAuthors')}: ${file.authors.length === 0 ? '—' : file.authors.join(', ')}`,
    ].join('<br/>');
  };

  /** The cells of the folder the reader stands in: its own files and the folders just below it. */
  const cells = useMemo(() => {
    const level = folderLevel(files, folder);
    const cells: MapCell[] = level.files.map((file) => ({
      name: file.path.slice(file.path.lastIndexOf('/') + 1),
      path: file.path,
      value: area === 'lines' ? (file.lines ?? 0) : (file.bytes ?? 0),
      measure: measureOfFile(file),
      file: true,
      href: byPath.get(file.path)?.href ?? null,
      tip: tipOf(file.path),
    }));
    for (const group of level.folders) {
      // A folder's colour is the measure of what it holds: the commits of its most-changed file (on the same
      // square-root scale as a file's own heat), the oldest change under it, or its most-authored file. Its area is the
      // sum of its files.
      let areaValue = 0;
      let heat = 0;
      let age = 0;
      let authors = 0;
      for (const file of group.files) {
        areaValue += area === 'lines' ? (file.lines ?? 0) : (file.bytes ?? 0);
        const member = byPath.get(file.path);
        if (member === undefined) continue;
        heat = Math.max(heat, heatOf(member, window));
        age = Math.max(age, ageOf(member));
        authors = Math.max(authors, member.authors.length);
      }
      const measure = colour === 'heat' ? { value: Math.sqrt(heat), none: heat === 0 } : colour === 'age' ? { value: age, none: age === 0 } : colour === 'authors' ? { value: authors, none: authors === 0 } : { value: -1, none: true };
      cells.push({
        name: group.name,
        path: group.path,
        value: areaValue,
        measure: measure.none && colour !== 'language' ? max + 1 : measure.value,
        file: false,
        href: null,
        files: group.files.length,
        count: t('knowledge.files.filesN', { count: group.files.length }),
        tip: [
          `${group.path}/`,
          `${t('knowledge.files.filesN', { count: group.files.length })}`,
          `${t('knowledge.files.colLines')}: ${countText(group.files.reduce((sum, file) => sum + (file.lines ?? 0), 0))}`,
          `${t('knowledge.files.colBytes')}: ${countText(group.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0))}`,
        ].join('<br/>'),
      });
    }
    return cells;
  }, [files, folder, area, colour, window, max, byPath, t, language]);

  // The map's root is the folder the page covers: a repository's whole tree, or the folder a directory page is about.
  // The breadcrumb climbs within that root and never leaves it, so a folder page does not silently become the root page.
  const root = block.data.folder;
  const breadcrumb = (): ReactElement => {
    const segments = crumbSegments(root, folder);
    const climb = (count: number): void => setFolder(count === 0 ? root : `${root}/${segments.slice(0, count).join('/')}`);
    return (
      <Breadcrumb className="dg-crumbs" aria-label={t('knowledge.files.breadcrumb')} data-testid="files-breadcrumb">
        <Button variant="ghost" size="content" type="button" className="dg-crumb" data-current={segments.length === 0 ? 'true' : 'false'} onClick={() => climb(0)} data-testid="files-crumb-root">
          {root === '' ? block.data.repository : root.slice(root.lastIndexOf('/') + 1)}
        </Button>
        {segments.map((segment, index) => (
          <Text key={`${segment}-${String(index)}`} className="dg-crumb-part">
            <Text aria-hidden="true" className="dg-crumb-sep">/</Text>
            <Button variant="ghost" size="content" type="button" className="dg-crumb" data-current={index === segments.length - 1 ? 'true' : 'false'} onClick={() => climb(index + 1)} data-testid="files-crumb">
              {segment}
            </Button>
          </Text>
        ))}
      </Breadcrumb>
    );
  };

  const legend = (): ReactElement => {
    if (colour === 'language') {
      return (
        <PlainList className="dg-legend-list" data-testid="files-legend" data-measure="language">
          {colours.map((entry) => (
            <li key={entry.name} data-testid="files-legend-entry">
              <ColourSwatch className="dg-swatch" background={entry.color} aria-hidden="true" />
              {entry.name}
            </li>
          ))}
        </PlainList>
      );
    }
    // The legend follows the measure the reader chose: the ends of the ramp are that measure's own numbers, and the
    // sentence says what the colour counts.
    const caption = colour === 'heat'
      ? t('knowledge.files.legendHeatCaption', { window: t(`knowledge.files.window.${window}`) })
      : colour === 'age' ? t('knowledge.files.legendAgeCaption') : t('knowledge.files.legendAuthorsCaption');
    const from = colour === 'heat' ? t('knowledge.files.commitsN', { count: 0 }) : colour === 'age' ? t('knowledge.files.today') : t('knowledge.files.authorsN', { count: 1 });
    const to = colour === 'heat' ? t('knowledge.files.commitsN', { count: rawMax }) : colour === 'age' ? t('knowledge.files.daysN', { count: rawMax }) : t('knowledge.files.authorsN', { count: Math.max(1, maxAuthors) });
    return (
      <Stack className="dg-legend-ramp" data-testid="files-legend" data-measure={colour}>
        <Text className="dg-legend-caption">{caption}</Text>
        <Text>{from}</Text>
        <ColourSwatch className="dg-ramp-wide" background={rampStyle(ramp)} aria-hidden="true" />
        <Text>{to}</Text>
      </Stack>
    );
  };

  const picture = useMemo((): { source: string; drawn: number; omitted: number } => {
    if (area === block.area && folder === block.data.folder) return { source: block.mermaid, drawn: block.mermaidDrawn, omitted: block.mermaidOmitted };
    const under = folder === '' ? files : files.filter((file) => file.path.startsWith(`${folder}/`));
    const built = mermaidTreemap(under, folder, area, MERMAID_LIMIT);
    return { source: built.source, drawn: built.drawn, omitted: built.omitted };
  }, [area, folder, block.area, block.mermaid, block.mermaidDrawn, block.mermaidOmitted, block.data.folder, files]);

  return (
    <section data-block="files-map" data-diagram="treemap" aria-label={block.title}>
      <h2>{block.title}</h2>
      <Paragraph className="dg-totals" data-testid="files-totals">
        {t('knowledge.files.totals', { count: block.data.totals.languages.length, files: countText(block.data.totals.files), lines: linesText(block.data.totals.lines) })}
      </Paragraph>
      <Stack className="dg-files-controls" data-testid="files-switches">
        <SegmentedChoice
          label={t('knowledge.files.area')}
          testId="files-area"
          value={area}
          onChange={(next) => setArea(next as typeof area)}
          options={[
            { value: 'lines', label: t('knowledge.files.lines'), testId: 'files-area-lines' },
            { value: 'bytes', label: t('knowledge.files.bytes'), testId: 'files-area-bytes' },
          ]}
        />
        <SegmentedChoice
          label={t('knowledge.files.colour')}
          testId="files-colour"
          value={colour}
          onChange={(next) => setColour(next as FilesMapColour)}
          options={COLOURS.map((one) => ({ value: one, label: t(`knowledge.files.colour_${one}`), testId: `files-colour-${one}` }))}
        />
        {colour === 'heat' && (
          <SegmentedChoice
            label={t('knowledge.files.windowLabel')}
            testId="files-window"
            value={window}
            onChange={(next) => setWindow(next as FilesMapWindow)}
            options={WINDOWS.map((one) => ({ value: one, label: t(`knowledge.files.window.${one}`), testId: `files-window-${one}` }))}
          />
        )}
        <SegmentedChoice
          label={t('knowledge.files.engine')}
          testId="files-engine"
          value={engine}
          onChange={(next) => setEngine(next as FilesMapEngine)}
          options={[
            { value: 'echarts', label: 'ECharts', testId: 'files-engine-echarts' },
            { value: 'mermaid', label: 'Mermaid', testId: 'files-engine-mermaid' },
          ]}
        />
      </Stack>
      {breadcrumb()}
      <Figure className="m-0">
        <DrawingSurface ref={holder} className="dg-treemap" data-testid="files-map">
          {engine === 'mermaid'
            ? <Stack className="dg-static"><MermaidDiagram source={picture.source} title={block.title} place={block.title} />
                {picture.omitted > 0 && <Paragraph className="text-small text-muted" data-testid="files-static-cut">{t('knowledge.files.staticCut', { count: picture.omitted, drawn: picture.drawn, omitted: picture.omitted })}</Paragraph>}
              </Stack>
            : width > 0 && (
              <Suspense fallback={<Paragraph role="status" className="p-3">{t('knowledge.diagram.drawing')}</Paragraph>}>
                <EChartsTreemap
                  cells={cells}
                  dark={dark}
                  height={height}
                  label={`${block.title}: ${t('knowledge.files.range', { from: 1, to: cells.length, total: cells.length, all: files.length })}`}
                  colouring={{ colour, ramp, max, languageColours: colours.map((entry) => entry.color) }}
                  onDrill={setFolder}
                  onOpen={open}
                />
                {cells.length === 0 && <Paragraph className="p-3 text-small text-muted" data-testid="files-map-empty">{t('knowledge.files.emptyMap')}</Paragraph>}
              </Suspense>
            )}
        </DrawingSurface>
        <FigureCaption className="dg-legend" data-testid="files-legend-caption">
          {legend()}
          {block.notes.map((note) => <Text key={note} className="dg-note">{note}</Text>)}
        </FigureCaption>
      </Figure>
    </section>
  );
}
