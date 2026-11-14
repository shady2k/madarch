/** One entity's relations, each row naming the relation and the entity at its other end (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { titleIn } from '../../../../src/page-contract/index.js';
import { Table } from './ui/data.js';
import { Link, Muted } from './ui/typography.js';
import { at, localized } from './format.js';
import { entityHref, edgesOf } from './connection.js';
import type { SectionContext } from './types.js';

export function RelationsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const connection = at(context.data, context.section.params['path']);
  const labelPath = typeof context.section.params['labelPath'] === 'string' ? context.section.params['labelPath'] : 'relation';
  const edges = edgesOf(connection);
  if (edges.length === 0) return <Muted>{localized(context.section.params['emptyText'], context.language) ?? titleIn(context.section.title, context.language) ?? ''}</Muted>;
  const rows = edges.map((edge) => {
    const node = (edge['node'] ?? {}) as Record<string, unknown>;
    const other = (node['from'] ?? node['to']) as Record<string, unknown> | undefined;
    const href = other === undefined ? undefined : entityHref(other);
    return [
      localized(node[labelPath], context.language) ?? String(node[labelPath] ?? ''),
      href === undefined ? '' : <Link href={context.base + href} onOpen={context.open}>{String(other?.['label'] ?? '') || href}</Link>,
    ];
  });
  return <Table head={[titleIn(context.section.title, context.language) ?? '', '']} rows={rows} />;
}
