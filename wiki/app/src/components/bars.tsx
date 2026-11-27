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
import { bucketRows, countedRows, rankedValue } from './aggregate.js';
import { edgesOf } from './connection.js';
import type { SectionContext } from './types.js';

export function BarsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const connection = at(context.data, context.section.params['path']);
  const labelPath = typeof context.section.params['labelPath'] === 'string' ? context.section.params['labelPath'] : 'key';
  const valuePath = typeof context.section.params['valuePath'] === 'string' ? context.section.params['valuePath'] : undefined;
  const buckets = context.section.params['buckets'] === true;
  const records = edgesOf(connection);
  const ranking = Array.isArray(connection) && valuePath === 'value' && records.every((row) => 'node' in row);
  const labelOf = (row: Record<string, unknown>): string =>
    formatValue(at(row, labelPath), 'text', context.language) || t('common.emptyValue');
  const rows = buckets
    ? bucketRows(records, t)
    : ranking ? records.map((row) => ({ label: labelOf(row), value: rankedValue(at(row, valuePath), context.language) }))
    : countedRows(records.map((row) => {
        const value = valuePath === undefined ? 1 : Number(at(row, valuePath));
        return { label: labelOf(row), value: Number.isFinite(value) ? value : 1 };
      }));
  if (rows.length === 0) return <Paragraph data-testid="bars-empty">{t('common.emptyValue')}</Paragraph>;
  return (
    <FactChart
      display={typeof context.section.params['display'] === 'string' ? (context.section.params['display'] as 'bar' | 'treemap' | 'timeline') : 'bar'}
      rows={rows}
      labelTitle={titleIn(context.section.title, context.language) ?? ''}
      valueTitle=""
      note={t('facts.noValues')}
    />
  );
}
