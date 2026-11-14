/** The data surfaces a page's sections are drawn on: a fact list, a table, a bar chart and a disclosure. */
import type { ReactElement, ReactNode } from 'react';

export function Badge({ children }: { readonly children: ReactNode }): ReactElement {
  return <span className="rounded bg-pill px-2 py-0.5 text-small text-secondary">{children}</span>;
}

export function FactList({ rows }: { readonly rows: readonly { readonly label: string; readonly value: ReactNode }[] }): ReactElement {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-[minmax(8rem,14rem)_1fr]">
      {rows.map((row, at) => (
        <div key={`${row.label}-${String(at)}`} className="contents">
          <dt className="text-small text-secondary">{row.label}</dt>
          <dd className="text-body text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ head, rows, empty }: { readonly head: readonly string[]; readonly rows: readonly ReactNode[][]; readonly empty?: string }): ReactElement {
  if (rows.length === 0) return <p className="text-small text-muted">{empty ?? ''}</p>;
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="w-full border-collapse text-body">
        <thead className="bg-chrome text-left text-small text-secondary">
          <tr>{head.map((cell, at) => <th key={`${cell}-${String(at)}`} scope="col" className="px-3 py-2 font-medium">{cell}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, at) => (
            <tr key={String(at)} className="border-t border-line">
              {row.map((cell, index) => <td key={String(index)} className="px-3 py-1 align-top text-ink">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A horizontal bar per group; the widest group fills the column. */
export function Bars({ rows }: { readonly rows: readonly { readonly label: string; readonly value: number; readonly href?: string }[] }): ReactElement {
  const widest = rows.reduce((most, row) => Math.max(most, row.value), 0);
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(6rem,12rem)_1fr_auto] items-center gap-2 text-small">
          <span className="truncate text-secondary" title={row.label}>{row.label}</span>
          <span className="h-2 rounded bg-chrome" style={{ width: widest === 0 ? '0%' : `${String(Math.max((row.value / widest) * 100, 2))}%` }} />
          <span className="text-muted">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function Disclosure({ summary, children }: { readonly summary: string; readonly children: ReactNode }): ReactElement {
  return (
    <details className="rounded border border-line px-3 py-2">
      <summary className="cursor-pointer text-small text-secondary">{summary}</summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

export function Notice({ children }: { readonly children: ReactNode }): ReactElement {
  return <p role="status" className="rounded border border-line bg-chrome px-3 py-2 text-small text-secondary">{children}</p>;
}
