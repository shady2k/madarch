import type { ReactElement } from 'react';
import { ChartBar, ChartSparkline, ChartTreemap } from './charts.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.js';
import { TextLink } from './typography.js';
import { Progress } from './progress.js';

/**
 * Accessible aggregate displays: the values stay readable and linked beside
 * their marks (madarch-64o5.82, the owner's approval of the audit's row). The
 * three displays are the kit's figures now — bars, a treemap of the same
 * values, a sparkline of the sequence — and the table under them is what makes
 * a figure readable without sight and what a reader copies from.
 */
export function FactChart({ display, rows, labelTitle, valueTitle, note }: {
  display: 'bar' | 'treemap' | 'timeline';
  rows: readonly { label: string; value: number | string; href?: string }[];
  labelTitle: string;
  valueTitle: string;
  /** The words an empty figure says, in the reader's language. */
  note: string;
}): ReactElement {
  const plotted = rows.flatMap(({ label, value }) => typeof value === 'number' ? [{ label, value }] : []);
  const showChart = plotted.length === rows.length;
  const maximum = Math.max(1, ...plotted.map((row) => row.value));
  // A row's bar takes a line of type plus its gap; a short list stays chart-shaped rather than a single stripe.
  const height = Math.max(140, Math.min(340, rows.length * 34 + 64));
  return <div className="grid gap-4" data-display={display}>
    {showChart && display === 'bar' && <ChartBar title={valueTitle} rows={plotted} width={520} height={height} note={note} />}
    {showChart && display === 'treemap' && <ChartTreemap title={valueTitle} nodes={plotted.filter((row) => row.value > 0)} width={520} height={160} note={note} />}
    {showChart && display === 'timeline' && <ChartSparkline title={valueTitle} values={plotted.map((row) => row.value)} width={480} height={96} note={note} />}
    <Table>
      <TableHeader><TableRow><TableHead>{labelTitle}</TableHead><TableHead>{valueTitle}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row, index) => <TableRow key={index}>
        <TableCell>{row.href === undefined ? row.label : <TextLink href={row.href}>{row.label}</TextLink>}</TableCell>
        <TableCell>{row.value}{showChart && display !== 'treemap' && typeof row.value === 'number' && <Progress value={row.value} max={maximum} aria-label={row.label} />}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>;
}
