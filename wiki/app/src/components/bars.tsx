/**
 * The groups of a list the section read, as one bar each (decision 0036, section 7): a connection's rows counted by a
 * label, an aggregate's groups, its ranking, or its buckets — the numbers are the graph's, the drawing is the kit's.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { titleIn } from '../../../../src/page-contract/index.js';
import { FactChart } from './ui/fact-chart.js';
import { Paragraph } from './ui/typography.js';
import { at, formatValue } from './format.js';
import { edgesOf } from './connection.js';
import type { SectionContext } from './types.js';

export function BarsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const connection = at(context.data, context.section.params['path']);
  const labelPath = typeof context.section.params['labelPath'] === 'string' ? context.section.params['labelPath'] : 'key';
  const valuePath = typeof context.section.params['valuePath'] === 'string' ? context.section.params['valuePath'] : undefined;
  const buckets = context.section.params['buckets'] === true;
  const rows = buckets
    ? bucketRows(edgesOf(connection), t)
    : edgesOf(connection).map((row) => {
        const raw = at(row, labelPath);
        const label = raw === null || raw === undefined ? t('common.emptyValue') : formatValue(raw, 'text', context.language);
        const value = valuePath === undefined ? 1 : Number(at(row, valuePath));
        return { label: label === '' ? t('common.emptyValue') : label, value: Number.isFinite(value) ? value : 1 };
      });
  const sorted = buckets ? rows : groupOf(rows);
  if (sorted.length === 0) return <Paragraph data-testid="bars-empty">{t('common.emptyValue')}</Paragraph>;
  return (
    <FactChart
      display={typeof context.section.params['display'] === 'string' ? (context.section.params['display'] as 'bar' | 'treemap' | 'timeline') : 'bar'}
      rows={sorted}
      labelTitle={titleIn(context.section.title, context.language) ?? ''}
      valueTitle=""
    />
  );
}

/** The rows of a plain count, the fullest first: what a connection or a group-by answers. */
function groupOf(rows: readonly { label: string; value: number }[]): { label: string; value: number }[] {
  const counted = new Map<string, number>();
  for (const row of rows) counted.set(row.label, (counted.get(row.label) ?? 0) + row.value);
  return [...counted.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([label, value]) => ({ label, value }));
}

/** The buckets of a histogram, named by the days they cover: the age of what the graph holds, oldest last. */
function bucketRows(rows: readonly Record<string, unknown>[], t: (key: string, options?: Record<string, unknown>) => string): { label: string; value: number }[] {
  const counted = rows.map((row) => ({ from: at(row, 'from'), to: at(row, 'to'), count: Number(at(row, 'count') ?? 0) }));
  return counted.map((row) => {
    const from = typeof row.from === 'number' ? row.from : undefined;
    const to = typeof row.to === 'number' ? row.to : undefined;
    const label = from === undefined && to !== undefined
      ? t('knowledge.bucket.under', { to })
      : to === undefined && from !== undefined
        ? t('knowledge.bucket.over', { from })
        : t('knowledge.bucket.between', { from, to });
    return { label, value: row.count };
  });
}
