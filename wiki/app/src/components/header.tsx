/**
 * The page's title and where it stands (decision 0036, section 7): the frame page or the kind the page belongs to, then
 * the path to the page, then its own name. The kind wears the catalogue's word for it in the reader's language; the
 * graph's own name for the kind is never shown.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CATALOGUE_KIND, titleIn, valueAt } from '../../../../src/page-contract/index.js';
import { Badge } from './ui/badge.js';
import { PageBreadcrumb, type TrailCrumb } from './ui/breadcrumb.js';
import { InlineGroup, Metadata, PageHeader, PageTitle } from './ui/typography.js';
import { follow } from './relations.js';
import { CATALOGUE_PAGE, entityAddress } from '../address.js';
import type { SectionContext } from './types.js';

interface TrailParams {
  readonly repository?: unknown;
  readonly path?: unknown;
}

interface Trail {
  readonly repository: string;
  readonly path: string;
}

export function HeaderSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const params = context.section.params;
  const titlePath = typeof params['titlePath'] === 'string' ? params['titlePath'] : 'label';
  const kindPath = typeof params['kindPath'] === 'string' ? params['kindPath'] : undefined;
  const provenancePath = typeof params['provenancePath'] === 'string' ? params['provenancePath'] : undefined;
  const title = textOf(valueAt(context.data, titlePath)) ?? titleIn(context.section.title, context.language) ?? '';
  const kind = kindPath === undefined ? undefined : textOf(valueAt(context.data, kindPath));
  const provenance = provenancePath === undefined ? undefined : textOf(valueAt(context.data, provenancePath));
  return (
    <PageHeader data-testid="page-header">
      <PageBreadcrumb label={t('knowledge.breadcrumb')} items={crumbsOf(context, t('navigation.catalogue'), title, kind)} />
      <PageTitle data-testid="page-title">{title}</PageTitle>
      {kind === undefined || kind === CATALOGUE_KIND ? null : <InlineGroup><Badge data-testid="page-kind">{kindWord(kind, context)}</Badge></InlineGroup>}
      {provenance === undefined ? null : <Metadata>{provenance}</Metadata>}
    </PageHeader>
  );
}

/** The catalogue's word for a kind in the reader's language, from the frame's one navigation read. */
export function kindWord(kind: string, context: SectionContext): string {
  const held = context.navigation?.kinds.find((one) => one.kind === kind);
  return held === undefined ? kind : held.one;
}

/** A link into the app's own addresses: the base it is served under, and the press that walks without a page load. */
function linkTo(context: SectionContext, address: string, label: string): TrailCrumb {
  const href = context.base + address;
  return { label, href, onClick: follow(context.open, href) };
}

/**
 * The page's trail (the owner's frame decision, restore-9): a frame page or a template page stands by its own name; a
 * kind's catalogue page is «Catalogue / kind»; every other entity is its kind's plural, linked to the kind's page, then
 * the repository and folders it lies in, then its own name.
 */
function crumbsOf(context: SectionContext, catalogue: string, title: string, kind: string | undefined): TrailCrumb[] {
  if (context.pageName !== null) return [{ label: context.pageName }];
  if (kind === CATALOGUE_KIND) return [linkTo(context, CATALOGUE_PAGE, catalogue), { label: title }];
  const trail = trailOf(context.section.params['trail'], context);
  const path = trail === null ? '' : [trail.repository, ...foldersOf(trail.path)].join(' / ');
  if (kind === undefined) return path === '' ? [{ label: title }] : [{ label: path }, { label: title }];
  const held = context.navigation?.kinds.find((one) => one.kind === kind);
  const address = held === undefined || held.entryId === null ? CATALOGUE_PAGE : entityAddress(CATALOGUE_KIND, held.entryId);
  const head = linkTo(context, address, held?.many ?? kindWord(kind, context));
  return path === '' ? [head, { label: title }] : [head, { label: path }, { label: title }];
}

/** The repository and the folders a code entity lies in: the trail the template named, less the page's own path. */
function trailOf(trail: unknown, context: SectionContext): Trail | null {
  if (typeof trail !== 'object' || trail === null) return null;
  const held = trail as TrailParams;
  const repository = typeof held.repository === 'string' ? valueAt(context.data, held.repository) : undefined;
  const path = typeof held.path === 'string' ? valueAt(context.data, held.path) : undefined;
  if (typeof repository !== 'string' || repository === '') return null;
  return { repository, path: typeof path === 'string' ? path : '' };
}

function foldersOf(path: string): string[] {
  return path.split('/').filter((one) => one !== '').slice(0, -1);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
