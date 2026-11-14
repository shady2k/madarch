/** The page's title, the entity's kind as a badge and where it came from (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { titleIn, valueAt } from '../../../../src/page-contract/index.js';
import { Inline, Stack } from './ui/layout.js';
import { Badge } from './ui/data.js';
import { Heading, Muted } from './ui/typography.js';
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
    <Stack gap={2}>
      <Heading>{title}</Heading>
      {kind === undefined ? null : <Inline gap={2}><Badge>{kind}</Badge></Inline>}
      {provenance === undefined ? null : <Muted>{provenance}</Muted>}
    </Stack>
  );
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
