/** A section's labelled values, each read at a dot path (decision 0036, section 7). */
import type { ReactElement, ReactNode } from 'react';
import { titleIn, valueAt } from '../../../../src/page-contract/index.js';
import { FactList } from './ui/data.js';
import { Link } from './ui/typography.js';
import { formatValue } from './format.js';
import type { SectionContext } from './types.js';

interface FactRow {
  readonly label?: unknown;
  readonly path?: unknown;
  readonly format?: unknown;
}

export function FactsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const rows = Array.isArray(context.section.params['rows']) ? (context.section.params['rows'] as FactRow[]) : [];
  const facts = rows.map((row, at) => {
    const path = typeof row.path === 'string' ? row.path : '';
    const format = typeof row.format === 'string' ? row.format : 'text';
    const value = valueAt(context.data, path);
    return { label: (typeof row.label === 'object' && row.label !== null ? titleIn(row.label as Record<string, string>, context.language) : undefined) ?? `#${String(at + 1)}`, value: cell(value, format, context) };
  });
  return <FactList rows={facts} />;
}

function cell(value: unknown, format: string, context: SectionContext): ReactNode {
  if (format === 'link' && typeof value === 'string') return <Link href={value}>{value}</Link>;
  if (Array.isArray(value)) return value.map((one) => formatValue(one, format, context.language)).join(', ');
  return formatValue(value, format, context.language);
}
