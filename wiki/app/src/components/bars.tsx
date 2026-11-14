/** The groups of a list the section read, as one bar each (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { titleIn } from '../../../../src/page-contract/index.js';
import { FactChart } from './ui/fact-chart.js';
import { Paragraph } from './ui/typography.js';
import { at, formatValue } from './format.js';
import { edgesOf } from './connection.js';
import type { SectionContext } from './types.js';

export function BarsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const connection = at(context.data, context.section.params['path']);
  const labelPath = typeof context.section.params['labelPath'] === 'string' ? context.section.params['labelPath'] : 'node.group';
  const valuePath = typeof context.section.params['valuePath'] === 'string' ? context.section.params['valuePath'] : undefined;
  const counts = new Map<string, number>();
  for (const edge of edgesOf(connection)) {
    const label = formatValue(at(edge, labelPath), 'text', context.language);
    const value = valuePath === undefined ? 1 : Number(at(edge, valuePath));
    counts.set(label === '' ? '—' : label, (counts.get(label) ?? 0) + (Number.isFinite(value) ? value : 1));
  }
  const rows = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([label, value]) => ({ label, value }));
  if (rows.length === 0) return <Paragraph>—</Paragraph>;
  return <FactChart display="bar" rows={rows} labelTitle={titleIn(context.section.title, context.language) ?? ''} valueTitle="" />;
}
