/**
 * The rows an aggregate's own answer holds, labelled the way a reader reads them (decision 0036, sections 4 and 7): the
 * groups of a group-by, the buckets of a histogram and a ranking's first rows, so `bars` and `fact` draw one answer the
 * same way. The numbers are the graph's; nothing here counts a population in the browser but the rows the answer named.
 */
import type { TFunction } from 'i18next';
import { at, formatValue, momentWords } from './format.js';

/** One row of an aggregate as a chart draws it: its label and its count. */
export interface AggregateRow {
  readonly label: string;
  readonly value: number;
}

/** Rankings can hold a date or another scalar without a meaningful numeric scale. */
export function rankedValue(value: unknown, language: string): number | string {
  if (value instanceof Date || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value))) {
    return momentWords(formatValue(value, 'text', language), language);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : formatValue(value, 'text', language);
}

/** The rows of a plain count, the fullest first: what a connection or a group-by answers. */
export function countedRows(rows: readonly AggregateRow[]): AggregateRow[] {
  const counted = new Map<string, number>();
  for (const row of rows) counted.set(row.label, (counted.get(row.label) ?? 0) + row.value);
  return [...counted.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([label, value]) => ({ label, value }));
}

/** The buckets of a histogram, named by the days they cover: the age of what the graph holds, oldest last. */
export function bucketRows(rows: readonly Record<string, unknown>[], t: TFunction): AggregateRow[] {
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
