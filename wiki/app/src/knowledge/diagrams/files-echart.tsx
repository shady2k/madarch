/**
 * The repository map drawn by Apache ECharts (madarch-j9ao.1): the folders and
 * files of the folder the reader stands in, coloured by the measure they chose.
 * A click on a folder enters it and a click on a file opens its page.
 *
 * A cell's name stands at its top-left, a folder's above its file count, at no
 * less than 12 px and in the ink that reads on that cell's own fill (measured
 * after drawing: see the report). A cell too small for its words draws none of
 * them. Only the modules this block uses are imported (the treemap chart, the
 * tooltip, the visual map that colours the cells and the canvas renderer), and
 * the module is loaded by a dynamic import the first time a map opens.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import * as echarts from 'echarts/core';
import { TreemapChart } from 'echarts/charts';
import { TooltipComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { FilesMapColour } from '../types.js';
import type { Ramp } from '../files-measure.js';

echarts.use([TreemapChart, TooltipComponent, VisualMapComponent, CanvasRenderer]);

/** One cell of the map, as the chart draws it: a folder to enter, or a file to open. */
export interface MapCell {
  name: string;
  path: string;
  /** The area: the file's measure, or the sum of the files a folder holds. */
  value: number;
  /** The colour's measure: a language's index, a count of commits, days or authors. */
  measure: number;
  file: boolean;
  href: string | null;
  tip: string;
  /** The files a folder holds, for its second label line and its tooltip. */
  files?: number;
  /** The line under a folder's name, already in the reader's words ("21 files"). */
  count?: string;
}

/** What colours one map: the measure at hand, its ramp, and the colours of the languages when the measure is one. */
export interface MapColouring {
  colour: FilesMapColour;
  ramp: Ramp;
  /** The top of a continuous measure. */
  max: number;
  /** The colours of the languages, in the legend's order. */
  languageColours: readonly string[];
}

export interface EChartsTreemapProps {
  cells: readonly MapCell[];
  colouring: MapColouring;
  onDrill: (path: string) => void;
  onOpen: (href: string) => void;
  height: number;
  dark: boolean;
  /** What the canvas is of, for a reader who cannot see it: the folder and the totals. */
  label: string;
}

/** The surface a gap between cells is drawn in: the page's own colour. */
function surfaceColour(dark: boolean): string {
  return dark ? '#292929' : '#ffffff';
}

/** One colour from a list of stops at a position from 0 to 1, as the visual map interpolates them. */
export function rampColourAt(stops: readonly string[], at: number): string {
  if (stops.length === 0) return '#000000';
  if (stops.length === 1) return stops[0]!;
  const position = Math.min(1, Math.max(0, at)) * (stops.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(stops.length - 1, lower + 1);
  const weight = position - lower;
  const from = hexOf(stops[lower]!);
  const to = hexOf(stops[upper]!);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * weight);
  return `rgb(${String(mix(from[0], to[0]))}, ${String(mix(from[1], to[1]))}, ${String(mix(from[2], to[2]))})`;
}

function hexOf(colour: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(colour);
  if (match === null) return [0, 0, 0];
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The fill one cell is painted in: the language's colour, or the ramp at the measure's place. */
export function fillOf(measure: number, colouring: MapColouring): string {
  if (colouring.colour === 'language') return colouring.languageColours[measure] ?? colouring.ramp.none;
  if (measure < 0) return colouring.ramp.none;
  return rampColourAt(colouring.ramp.colors, measure / Math.max(1, colouring.max));
}

/** A colour's relative luminance (WCAG 2.1), from `#rrggbb` or `rgb(r, g, b)`. */
export function luminanceOf(colour: string): number {
  const rgb = colour.startsWith('#') ? hexOf(colour) : ((): [number, number, number] => {
    const nums = colour.match(/\d+/g) ?? ['0', '0', '0'];
    return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
  })();
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** The contrast between two colours (WCAG 2.1). */
export function contrastOf(one: string, other: string): number {
  const a = luminanceOf(one);
  const b = luminanceOf(other);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The ink that reads best on a fill: white on a dark tile, near-black on a light one. */
export function inkFor(fill: string): string {
  return contrastOf(fill, '#ffffff') >= contrastOf(fill, '#1c1c1c') ? '#ffffff' : '#1c1c1c';
}

const INK_LIGHT = '#ffffff';
const INK_DARK = '#1c1c1c';

/** A 12 px folder glyph in one ink, as a data URI a rich-text label can draw. */
export function folderIcon(ink: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${encodeURIComponent(ink)}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${svg.replaceAll('#', '%23')}`;
}

/** Whether a cell of this area (in square pixels) has room for its words: a folder needs two lines. */
export function labelFits(value: number, total: number, pixels: number, file: boolean): boolean {
  if (total <= 0 || pixels <= 0) return false;
  const area = (value / total) * pixels;
  return area >= (file ? 900 : 2_400);
}

interface CellData {
  name: string;
  path: string;
  value: [number, number];
  file: boolean;
  href: string | null;
  files?: number;
  label?: { show: boolean; formatter: string };
  tip: string;
  itemStyle?: { color: string };
}

/** The ECharts option of one map: the cells, the visual map that colours them and the cells' words. */
export function mapOption(props: EChartsTreemapProps, size: { width: number; height: number } = { width: 800, height: 520 }): Record<string, unknown> {
  const { colouring, cells, dark } = props;
  const surface = surfaceColour(dark);
  const total = cells.reduce((sum, cell) => sum + cell.value, 0);
  const pixels = size.width * size.height;
  const data: CellData[] = cells.map((cell) => {
    const fill = fillOf(cell.measure, colouring);
    const light = inkFor(fill) === INK_LIGHT;
    const shown = labelFits(cell.value, total, pixels, cell.file);
    const name = cell.name.replaceAll('}', '');
    const formatter = cell.file
      ? `{${light ? 'nameLight' : 'nameDark'}|${name}}`
      : `{${light ? 'iconLight' : 'iconDark'}|} {${light ? 'folderLight' : 'folderDark'}|${name}}${cell.count === undefined ? '' : `\n{${light ? 'countLight' : 'countDark'}|${cell.count.replaceAll('}', '')}}`}`;
    return {
      name: cell.name,
      path: cell.path,
      value: [cell.value, cell.measure],
      file: cell.file,
      href: cell.href,
      ...(cell.files === undefined ? {} : { files: cell.files }),
      tip: cell.tip,
      label: { show: shown, formatter },
    };
  });
  const ink = (light: boolean): string => (light ? INK_LIGHT : INK_DARK);
  const nameStyle = (light: boolean): Record<string, unknown> => ({ color: ink(light), fontSize: 12, fontWeight: 600, lineHeight: 15, align: 'left' });
  const folderStyle = (light: boolean): Record<string, unknown> => ({ ...nameStyle(light), padding: [0, 0, 0, 3] });
  const countStyle = (light: boolean): Record<string, unknown> => ({ color: ink(light), fontSize: 12, lineHeight: 15, align: 'left', padding: [1, 0, 0, 0] });
  const iconStyle = (light: boolean): Record<string, unknown> => ({ backgroundColor: { image: folderIcon(ink(light)) }, width: 12, height: 12, align: 'left' });
  return {
    animation: false,
    backgroundColor: 'transparent',
    // The tile's fill is the visual map's: piecewise for a language's index, continuous over the ramp for a measure.
    // The label's ink is computed from the same mapping, so the words and the tile always agree.
    visualMap: colouring.colour === 'language'
      ? {
          type: 'piecewise', show: false, seriesIndex: 0, dimension: 1,
          pieces: colouring.languageColours.map((color, value) => ({ value, color })),
          outOfRange: { color: colouring.ramp.none },
        }
      : {
          type: 'continuous', show: false, seriesIndex: 0, dimension: 1, min: 0, max: Math.max(1, colouring.max),
          inRange: { color: [...colouring.ramp.colors] }, outOfRange: { color: colouring.ramp.none },
        },
    tooltip: {
      confine: true,
      backgroundColor: dark ? '#2b2b2b' : '#ffffff',
      borderColor: dark ? '#444444' : '#e4e5e8',
      textStyle: { color: dark ? '#e5e5e5' : '#2e3034', fontSize: 12 },
      formatter: (params: { data?: { tip?: string } }) => params.data?.tip ?? '',
    },
    series: [
      {
        type: 'treemap',
        data,
        // ECharts 6's treemap reserves 20 px at the left and 50 px at the top for a label band by default; the map
        // fills the frame a reader sees, and the reader's own breadcrumb names the folder.
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        visualDimension: 1,
        animation: false,
        label: {
          show: true,
          position: 'insideTopLeft',
          distance: 0,
          padding: [4, 4, 4, 4],
          overflow: 'truncate',
          verticalAlign: 'top',
          lineHeight: 15,
          rich: {
            nameLight: nameStyle(true), nameDark: nameStyle(false),
            folderLight: folderStyle(true), folderDark: folderStyle(false),
            countLight: countStyle(true), countDark: countStyle(false),
            iconLight: iconStyle(true), iconDark: iconStyle(false),
          },
        },
        itemStyle: { borderColor: surface, borderWidth: 0, gapWidth: 1 },
        visibleMin: 1,
      },
    ],
  };
}

/** The chart itself: created once, its option replaced when the reader changes a switch or enters a folder. */
export function EChartsTreemap(props: EChartsTreemapProps): ReactElement {
  const holder = useRef<HTMLDivElement | null>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const click = useRef({ drill: props.onDrill, open: props.onOpen });
  click.current = { drill: props.onDrill, open: props.onOpen };
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const made = echarts.init(element, undefined, { renderer: 'canvas' });
    chart.current = made;
    // The instance stays on the element it draws in, so a walk that checks what a reader sees (the acceptance
    // measurement of label size and contrast) can read the drawn words and their tiles without a second renderer.
    (element as HTMLElement & { __map?: unknown }).__map = made;
    made.on('click', (params: unknown) => {
      const data = (params as { data?: { path?: string; file?: boolean; href?: string | null } }).data;
      if (data === undefined || data.path === undefined) return;
      if (data.file === true) {
        if (typeof data.href === 'string' && data.href !== '') click.current.open(data.href);
        return;
      }
      click.current.drill(data.path);
    });
    const resize = new ResizeObserver(() => made.resize());
    resize.observe(element);
    return () => {
      resize.disconnect();
      made.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    const element = holder.current;
    const size = { width: element?.clientWidth ?? 800, height: props.height };
    chart.current?.setOption(mapOption(props, size), true);
  }, [props.cells, props.colouring, props.dark, props.height]);
  return <div ref={holder} className="dg-chart" style={{ width: '100%', height: `${String(props.height)}px` }} data-testid="files-map-chart" role="img" aria-label={props.label} />;
}
