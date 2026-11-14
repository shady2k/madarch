/** The page's title, the entity's kind as a badge and where it came from (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { titleIn, valueAt } from '../../../../src/page-contract/index.js';
import { Badge } from './ui/badge.js';
import { InlineGroup, Metadata, PageHeader, PageTitle } from './ui/typography.js';
import type { SectionContext } from './types.js';

export function HeaderSection({ context }: { readonly context: SectionContext }): ReactElement {
  const params = context.section.params;
  const titlePath = typeof params['titlePath'] === 'string' ? params['titlePath'] : 'label';
  const kindPath = typeof params['kindPath'] === 'string' ? params['kindPath'] : undefined;
  const provenancePath = typeof params['provenancePath'] === 'string' ? params['provenancePath'] : undefined;
  const title = textOf(valueAt(context.data, titlePath)) ?? titleIn(context.section.title, context.language) ?? '';
  const kind = kindPath === undefined ? undefined : textOf(valueAt(context.data, kindPath));
  const provenance = provenancePath === undefined ? undefined : textOf(valueAt(context.data, provenancePath));
  return (
    <PageHeader data-testid="page-header">
      {kind === undefined ? null : <InlineGroup><Badge data-testid="page-kind">{kind}</Badge></InlineGroup>}
      <PageTitle data-testid="page-title">{title}</PageTitle>
      {provenance === undefined ? null : <Metadata>{provenance}</Metadata>}
    </PageHeader>
  );
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
