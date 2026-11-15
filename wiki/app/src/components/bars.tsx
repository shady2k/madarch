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
import { bucketRows, countedRows } from './aggregate.js';
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
        const label = raw === null || raw === undefined ? '—' : formatValue(raw, 'text', context.language);
        const value = valuePath === undefined ? 1 : Number(at(row, valuePath));
        return { label: label === '' ? '—' : label, value: Number.isFinite(value) ? value : 1 };
      });
  const sorted = buckets ? rows : countedRows(rows);
  if (sorted.length === 0) return <Paragraph data-testid="bars-empty">—</Paragraph>;
  return (
    <FactChart
      display={typeof context.section.params['display'] === 'string' ? (context.section.params['display'] as 'bar' | 'treemap' | 'timeline') : 'bar'}
      rows={sorted}
      labelTitle={titleIn(context.section.title, context.language) ?? ''}
      valueTitle=""
    />
  );
}
