/**
 * The page's title, the kind it is an entity of and where it stands (decision 0036, section 7): the product, the
 * repository and the folders the entity lies in, then its own name. The kind wears the catalogue's word for it in the
 * reader's language; the graph's own name for the kind is never shown.
 */
import type { ReactElement } from 'react';
import { titleIn, valueAt } from '../../../../src/page-contract/index.js';
import { Badge } from './ui/badge.js';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from './ui/breadcrumb.js';
import { InlineGroup, Metadata, PageHeader, PageTitle } from './ui/typography.js';
import { follow } from './relations.js';
import type { SectionContext } from './types.js';

interface TrailParams {
  readonly repository?: unknown;
  readonly path?: unknown;
}

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
      {trailOf(params['trail'], title, context)}
      {kind === undefined ? null : <InlineGroup><Badge data-testid="page-kind">{kindWord(kind, context)}</Badge></InlineGroup>}
      <PageTitle data-testid="page-title">{title}</PageTitle>
      {provenance === undefined ? null : <Metadata>{provenance}</Metadata>}
    </PageHeader>
  );
}

/** The catalogue's word for a kind in the reader's language, from the frame's one navigation read. */
export function kindWord(kind: string, context: SectionContext): string {
  const held = context.navigation?.kinds.find((one) => one.kind === kind);
  return held === undefined ? kind : held.one;
}

/**
 * The way up to the entity: the product, its repository and the folders it lies in, the entity's own name last. The
 * folders are the segments of the path the template named; the product is the frame's own reading, linked home.
 */
function trailOf(trail: unknown, title: string, context: SectionContext): ReactElement | null {
  if (typeof trail !== 'object' || trail === null) return null;
  const held = trail as TrailParams;
  const repository = typeof held.repository === 'string' ? valueAt(context.data, held.repository) : undefined;
  const path = typeof held.path === 'string' ? valueAt(context.data, held.path) : undefined;
  if (typeof repository !== 'string' || repository === '') return null;
  const segments = typeof path === 'string' ? path.split('/').filter((one) => one !== '').slice(0, -1) : [];
  return (
    <Breadcrumb aria-label="trail" data-testid="trail">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href={context.base + '/'} onClick={follow(context.open, context.base + '/')}>{context.product ?? repository}</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem><BreadcrumbPage>{repository}</BreadcrumbPage></BreadcrumbItem>
        {segments.map((segment, at) => (
          <BreadcrumbItem key={`${segment}-${String(at)}`}>
            <BreadcrumbSeparator />
            <BreadcrumbPage>{segment}</BreadcrumbPage>
          </BreadcrumbItem>
        ))}
        <BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbPage>{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
