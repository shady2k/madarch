import type { ReactElement } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.js';
import { TextLink } from './typography.js';
import { Progress } from './progress.js';

/** Accessible aggregate displays: the values stay readable and linked beside their marks. */
export function FactChart({ display, rows, labelTitle, valueTitle }: {
  display: 'bar' | 'treemap' | 'timeline';
  rows: readonly { label: string; value: number; href?: string }[];
  labelTitle: string;
  valueTitle: string;
}): ReactElement {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  let offset = 0;
  return <div className="space-y-4" data-display={display}>
    {display === 'treemap' && total > 0 && <svg viewBox="0 0 100 24" role="img" aria-label={valueTitle} className="h-24 w-full text-ink">
      {rows.map((row, index) => {
        const width = Math.max(0, row.value) / total * 100;
        const x = offset;
        offset += width;
        return <rect key={index} x={x} y={0} width={width} height={24} fill="currentColor" stroke="var(--surface-page)" strokeWidth={0.5}><title>{row.label}: {row.value}</title></rect>;
      })}
    </svg>}
    {display === 'timeline' && rows.length > 0 && <svg viewBox="0 0 100 32" role="img" aria-label={valueTitle} className="h-32 w-full text-ink">
      <polyline fill="none" stroke="currentColor" strokeWidth={0.7} points={rows.map((row, index) => `${rows.length === 1 ? 50 : index / (rows.length - 1) * 98 + 1},${30 - Math.max(0, row.value) / maximum * 28}`).join(' ')} />
      {rows.map((row, index) => <circle key={index} cx={rows.length === 1 ? 50 : index / (rows.length - 1) * 98 + 1} cy={30 - Math.max(0, row.value) / maximum * 28} r={0.7} fill="currentColor"><title>{row.label}: {row.value}</title></circle>)}
    </svg>}
    <Table>
      <TableHeader><TableRow><TableHead>{labelTitle}</TableHead><TableHead>{valueTitle}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row, index) => <TableRow key={index}>
        <TableCell>{row.href === undefined ? row.label : <TextLink href={row.href}>{row.label}</TextLink>}</TableCell>
        <TableCell>{row.value}{display !== 'treemap' && <Progress value={row.value} max={maximum} aria-label={row.label} />}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>;
}
