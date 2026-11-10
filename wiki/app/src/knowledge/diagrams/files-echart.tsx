/**
 * The repository map drawn by Apache ECharts (madarch-j9ao.1): the folders and
 * files of the folder the reader stands in, coloured by the measure they chose.
 * A click on a folder enters it and a click on a file opens its page.
 *
 * Apache-2.0, pinned in package.json; only the modules this block uses are
 * imported (the treemap chart, the tooltip, the visual map that colours the
 * cells and the canvas renderer), and the module is loaded by a dynamic import
 * the first time a reader opens a map, so a page without one pays nothing for it.
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
  /** The files a folder holds, for the cell's tooltip and its accessible name. */
  files?: number;
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

/** The ECharts option of one map: the cells, the visual map that colours them and the cells' words. */
export function mapOption(props: EChartsTreemapProps): Record<string, unknown> {
  const { colouring, cells, dark } = props;
  const surface = surfaceColour(dark);
  const data = cells.map((cell) => ({
    name: cell.name,
    path: cell.path,
    value: [cell.value, cell.measure],
    file: cell.file,
    href: cell.href,
    files: cell.files,
    label: cell.name,
    tip: cell.tip,
  }));
  const visualMap = colouring.colour === 'language'
    ? {
        type: 'piecewise', show: false, seriesIndex: 0, dimension: 1,
        pieces: colouring.languageColours.map((color, value) => ({ value, color })),
        outOfRange: { color: colouring.ramp.none },
      }
    : {
        type: 'continuous', show: false, seriesIndex: 0, dimension: 1, min: 0, max: Math.max(1, colouring.max),
        inRange: { color: [...colouring.ramp.colors] }, outOfRange: { color: colouring.ramp.none },
      };
  return {
    animation: false,
    backgroundColor: 'transparent',
    visualMap,
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
        // fills the frame a reader sees. The reader's own breadcrumb above it names the folder, so the cells need no
        // upper-label band of their own.
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
          color: '#ffffff',
          fontSize: 11,
          textBorderColor: 'rgba(0,0,0,0.45)',
          textBorderWidth: 2,
          formatter: (params: { data?: { label?: string } }) => params.data?.label ?? '',
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
    chart.current?.setOption(mapOption(props), true);
  }, [props.cells, props.colouring, props.dark, props.height]);
  return <div ref={holder} className="dg-chart" style={{ width: '100%', height: `${String(props.height)}px` }} data-testid="files-map-chart" role="img" aria-label={props.label} />;
}
