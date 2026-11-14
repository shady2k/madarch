/**
 * The kit's figures (task madarch-64o5.82; the owner's choice of 2026-11-15):
 * six forms of the vendored diagrammatic — treemap, sunburst, bar, stacked bar,
 * matrix heatmap, sparkline — and the activity calendar in its two shapes,
 * heat-graph's interactive grid and diagrammatic's static calendar mark.
 *
 * A figure takes the kit's own shape of data — rows, a tree, a matrix, a list
 * of numbers, dated counts — and answers no colour of its own: `styles/charts.css`
 * gives every `--dg-*` token and every calendar step a value from the design
 * tokens, so a figure is drawn in the page's palette, type and light/dark
 * scheme. A shape with no data draws the kit's own line instead of an empty
 * frame, so a page never decides what a figure without data looks like.
 */
import type { ReactElement } from 'react';
import * as HeatGraph from 'heat-graph';
import { Bar } from '../../../../../vendor/diagrammatic/src/react/charts/bar.js';
import { Heatmap } from '../../../../../vendor/diagrammatic/src/react/charts/heatmap.js';
import { Sparkline } from '../../../../../vendor/diagrammatic/src/react/charts/sparkline.js';
import { StackedBar } from '../../../../../vendor/diagrammatic/src/react/charts/stacked-bar.js';
import { Sunburst } from '../../../../../vendor/diagrammatic/src/react/charts/sunburst.js';
import { Treemap } from '../../../../../vendor/diagrammatic/src/react/charts/treemap.js';
import { Paragraph } from './typography.js';

/** One row of a figure: its label and its value. */
export interface ChartRow { readonly label: string; readonly value: number }

/** One node of a hierarchy: its label, what it holds, and its children. */
export interface ChartNode { readonly label: string; readonly value?: number; readonly children?: readonly ChartNode[] }

/** One series across the same groups. */
export interface ChartSeries { readonly name: string; readonly data: readonly number[] }

/** A matrix: the row names down, the column names across, one value per cell. */
export interface ChartMatrix { readonly rows: readonly string[]; readonly cols: readonly string[]; readonly values: readonly (readonly number[])[] }

/** One day of the activity calendar. */
export interface ChartDay { readonly date: string; readonly count: number }

interface Size { readonly width?: number; readonly height?: number; readonly className?: string }

/** What a figure says where it has nothing to draw: the kit's own words, not an empty frame. */
function ChartEmpty({ title, note }: { readonly title: string; readonly note: string }): ReactElement {
  return <div className="rounded-[var(--radius-card)] border border-dashed border-line px-3 py-4 text-small text-muted" data-testid="chart-empty">
    <span className="block font-medium text-secondary">{title}</span>
    <Paragraph>{note}</Paragraph>
  </div>;
}

/** A tree drawn as areas: each child's area is its value's share of its parent's. */
export function ChartTreemap({ title, nodes, note = 'No values to draw', ...size }: Size & { readonly title: string; readonly nodes: readonly ChartNode[]; readonly note?: string }): ReactElement {
  if (!hasValues(nodes)) return <ChartEmpty title={title} note={note} />;
  return <Treemap title={title} root={{ label: title, children: nodes.map(nodeOf) }} {...size} />;
}

/** The same tree as rings: the root's children the first ring, their children the next. */
export function ChartSunburst({ title, nodes, note = 'No values to draw', ...size }: Size & { readonly title: string; readonly nodes: readonly ChartNode[]; readonly note?: string }): ReactElement {
  if (!hasValues(nodes)) return <ChartEmpty title={title} note={note} />;
  return <Sunburst title={title} root={{ label: title, children: nodes.map(nodeOf) }} {...size} />;
}

/** Rows as horizontal bars, zero-based. */
export function ChartBar({ title, rows, note = 'No values to draw', ...size }: Size & { readonly title: string; readonly rows: readonly ChartRow[]; readonly note?: string }): ReactElement {
  if (!rows.some((row) => row.value !== 0)) return <ChartEmpty title={title} note={note} />;
  return <Bar title={title} items={rows.map((row) => ({ label: row.label, value: row.value }))} {...size} />;
}

/** The same groups, each split into its series. */
export function ChartStackedBar({ title, groups, series, normalize = false, note = 'No values to draw', ...size }: Size & { readonly title: string; readonly groups: readonly string[]; readonly series: readonly ChartSeries[]; readonly normalize?: boolean; readonly note?: string }): ReactElement {
  if (series.length === 0 || !series.some((one) => one.data.some((value) => value !== 0))) return <ChartEmpty title={title} note={note} />;
  return <StackedBar title={title} groups={[...groups]} series={series.map((one) => ({ name: one.name, data: [...one.data] }))} normalize={normalize} {...size} />;
}

/** A matrix as cells; `mark` says how a cell is drawn, and `calendar` lays the columns out as weeks. */
export function ChartHeatmap({ title, matrix, mark = 'cell', printValues = false, note = 'No values to draw', ...size }: Size & { readonly title: string; readonly matrix: ChartMatrix; readonly mark?: 'cell' | 'dot' | 'calendar'; readonly printValues?: boolean; readonly note?: string }): ReactElement {
  if (matrix.rows.length === 0 || matrix.cols.length === 0 || !matrix.values.some((row) => row.some((value) => value !== 0))) return <ChartEmpty title={title} note={note} />;
  return <Heatmap title={title} matrix={{ rows: [...matrix.rows], cols: [...matrix.cols], values: matrix.values.map((row) => [...row]) }} mark={mark} values={printValues} {...size} />;
}

/** One series of numbers, one line of type tall. */
export function ChartSparkline({ title, values, note = 'No values to draw', ...size }: Size & { readonly title: string; readonly values: readonly number[]; readonly note?: string }): ReactElement {
  if (values.length === 0) return <ChartEmpty title={title} note={note} />;
  // A micro chart sits in a line of text by default; `block` gives it the host's width, and a height keeps it a band.
  return <Sparkline title={title} data={[...values]} block height={size.height ?? 40} {...(size.width === undefined ? {} : { width: size.width })} />;
}

/**
 * The activity calendar as a static figure: dated counts folded into weeks
 * across and weekdays down, drawn by the vendored calendar mark. Nothing here
 * reacts to a pointer; the interactive calendar is `ActivityCalendar`.
 */
export function ChartCalendar({ title, days, note = 'No activity to draw', ...size }: Size & { readonly title: string; readonly days: readonly ChartDay[]; readonly note?: string }): ReactElement {
  const matrix = calendarMatrix(days);
  if (matrix === undefined) return <ChartEmpty title={title} note={note} />;
  return <Heatmap title={title} matrix={matrix} mark="calendar" values={false} {...size} />;
}

/**
 * The activity calendar a reader can point at: heat-graph lays out the weeks,
 * the months and the days and wires the tooltip; every colour step is one step
 * of the kit's ink, handed over as the scale so no second palette appears.
 *
 * The figure is one image to a screen reader: its label carries the range and
 * the total, and the cells are the drawing. A page that needs the numbers
 * beside the picture draws them itself (`ChartHeatmap`, or a table).
 */
export function ActivityCalendar({ title, days, note = 'No activity to draw' }: { readonly title: string; readonly days: readonly ChartDay[]; readonly note?: string }): ReactElement {
  if (days.length === 0) return <ChartEmpty title={title} note={note} />;
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const dates = [...days.map((day) => day.date.slice(0, 10))].sort();
  return <div className="max-w-2xl" data-testid="activity-calendar" role="img" aria-label={`${title}: ${String(total)} in ${String(days.length)} days, ${dates[0] ?? ''} to ${dates[dates.length - 1] ?? ''}`}>
    <HeatGraph.Root data={days.map((day) => ({ date: day.date, count: day.count }))} weekStart="monday" colorScale={HEAT_STEPS}>
      <div className="mb-1 text-[10px] leading-none text-muted">
        <div className="grid" aria-hidden="true">
          <HeatGraph.MonthLabels>{({ label: month }) => <span style={{ gridColumn: month.column + 1 }} className="whitespace-nowrap">{MONTHS[month.month]}</span>}</HeatGraph.MonthLabels>
        </div>
      </div>
      <div className="flex items-start gap-1.5">
        <div className="grid pr-0.5 text-[10px] leading-none text-muted" aria-hidden="true" style={{ gridTemplateRows: 'repeat(7, minmax(0, 1fr))' }}>
          {WEEKDAYS.map((name, row) => <span key={name || String(row)} className="grid items-center" style={{ gridRow: row + 1 }}>{name}</span>)}
        </div>
        <HeatGraph.Grid className="min-w-0 flex-1 gap-[2px]" aria-hidden="true">
          {() => <HeatGraph.Cell className="aspect-square rounded-[2px] outline outline-1 outline-[var(--border-subtle)]" />}
        </HeatGraph.Grid>
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-1 text-[10px] text-muted" aria-hidden="true">
        <span>less</span>
        <HeatGraph.Legend>{() => <HeatGraph.LegendLevel className="size-3 rounded-[2px] outline outline-1 outline-[var(--border-subtle)]" />}</HeatGraph.Legend>
        <span>more</span>
      </div>
    </HeatGraph.Root>
  </div>;
}

/** The five steps a calendar cell takes: the page's soft surface, then four strengths of one ink. */
const HEAT_STEPS = ['var(--surface-soft)', 'var(--heat-step-1)', 'var(--heat-step-2)', 'var(--heat-step-3)', 'var(--heat-step-4)'];
const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A node as the vendored forms read one: a label, the value it holds, and its children. */
function nodeOf(node: ChartNode): ChartTreeNode {
  return {
    label: node.label,
    ...(node.value === undefined ? {} : { value: node.value }),
    ...(node.children === undefined ? {} : { children: node.children.map(nodeOf) }),
  };
}

/** The vendored tree shape, named here so the conversion is typed against it and not against a lookalike. */
type ChartTreeNode = { label: string; value?: number; children?: ChartTreeNode[] };

/** Whether a hierarchy holds any value at all, at any depth. */
function hasValues(nodes: readonly ChartNode[]): boolean {
  return nodes.some((node) => (node.value ?? 0) > 0 || (node.children !== undefined && hasValues(node.children)));
}

/**
 * Dated counts as the calendar mark's matrix: one row per weekday, one column
 * per week, Monday first. Undefined when no day carries a count.
 */
export function calendarMatrix(days: readonly ChartDay[]): { rows: string[]; cols: string[]; values: number[][] } | undefined {
  if (!days.some((day) => day.count > 0)) return undefined;
  const byDate = new Map<string, number>();
  for (const day of days) byDate.set(day.date.slice(0, 10), day.count);
  const sorted = [...byDate.keys()].sort();
  const first = new Date(`${sorted[0]!}T00:00:00Z`);
  const last = new Date(`${sorted[sorted.length - 1]!}T00:00:00Z`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return undefined;
  // The Monday of the week the first day stands in, and the Monday of the last one.
  const start = new Date(first); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(last); end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7));
  const values: number[][] = [[], [], [], [], [], [], []];
  const cols: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    cols.push(cursor.toISOString().slice(0, 10));
    for (let row = 0; row < 7; row += 1) {
      const day = new Date(cursor); day.setUTCDate(day.getUTCDate() + row);
      values[row]!.push(byDate.get(day.toISOString().slice(0, 10)) ?? 0);
    }
  }
  return { rows: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], cols, values };
}
