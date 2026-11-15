/**
 * The page's title and where it stands (decision 0036, section 7): the frame page or the kind the page belongs to, then
 * the path to the page, then its own name. The kind wears the catalogue's word for it in the reader's language; the
 * graph's own name for the kind is never shown.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CATALOGUE_KIND, titleIn, valueAt, type PageComposition } from '../../../../src/page-contract/index.js';
import { Badge } from './ui/badge.js';
import { PageBreadcrumb, type TrailCrumb } from './ui/breadcrumb.js';
import { InlineGroup, Metadata, PageHeader, PageHeading, PageTitle } from './ui/typography.js';
import { follow } from './relations.js';
import { entityAddress, PAGE_ADDRESSES } from '../address.js';
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
  // The home page names the product itself: its files' name, which the top bar shows, not the home entity's page title.
  const productTitle = params['productTitle'] === true ? context.product ?? context.navigation?.product ?? undefined : undefined;
  const kind = kindPath === undefined ? undefined : textOf(valueAt(context.data, kindPath));
  const provenance = provenancePath === undefined ? undefined : textOf(valueAt(context.data, provenancePath));
  const trail = trailOf(params['trail'], context.data);
  const chain = chainOf(params['chainPath'], context);
  // A code page is its file: the label is the whole path, so the title is the name and the path stands muted under it.
  const path = trail === null ? '' : trail.path;
  const name = lastSegment(path);
  const title = productTitle ?? name ?? textOf(valueAt(context.data, titlePath)) ?? titleIn(context.section.title, context.language) ?? '';
  const heading = <PageTitle data-testid="page-title">{title}</PageTitle>;
  return (
    <PageHeader data-testid="page-header">
      <PageBreadcrumb label={t('knowledge.breadcrumb')} items={crumbsOf(context, t('navigation.catalogue'), title, kind, trail, chain)} />
      {/* The trail already names the folders and the title the file: the path is not printed a second time (madarch-64o5.83). */}
      {path === '' || trail !== null ? heading : <PageHeading path={path}>{heading}</PageHeading>}
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
  return { label, href, ...follow(context.open, href) };
}

/**
 * The page's trail (the owner's frame decision, restore-9): a frame page or a template page stands by its own name; a
 * kind's catalogue page is «Catalogue / kind»; every other entity is its kind's plural, linked to the kind's page, then
 * the repository and folders it lies in, then its own name.
 */
function crumbsOf(context: SectionContext, catalogue: string, title: string, kind: string | undefined, trail: Trail | null, chain: TrailCrumb[]): TrailCrumb[] {
  if (context.pageName !== null) return [{ label: context.pageName }];
  if (kind === CATALOGUE_KIND) return [linkTo(context, PAGE_ADDRESSES.catalogue, catalogue), { label: title }];
  if (kind === undefined) {
    if (chain.length > 0) return [...chain, { label: title }];
    return trail === null ? [{ label: title }] : trailCrumbs(trail);
  }
  const held = context.navigation?.kinds.find((one) => one.kind === kind);
  const address = held === undefined || held.entryId === null ? PAGE_ADDRESSES.catalogue : entityAddress(CATALOGUE_KIND, held.entryId);
  const head = linkTo(context, address, held?.many ?? kindWord(kind, context));
  // A page whose graph answers its containers walks them, each a link; a code page walks its folder trail (madarch-64o5.134).
  if (chain.length > 0) return [head, ...chain, { label: title }];
  return trail === null ? [head, { label: title }] : trailCrumbs(trail, head);
}

/** The containers the graph answered for the page, each a link: the template's `chainPath` names the list it reads. */
function chainOf(path: unknown, context: SectionContext): TrailCrumb[] {
  if (typeof path !== 'string') return [];
  const held = valueAt(context.data, path);
  if (!Array.isArray(held)) return [];
  return held.flatMap((one) => {
    if (typeof one !== 'object' || one === null) return [];
    const crumb = one as Record<string, unknown>;
    const id = typeof crumb['id'] === 'string' ? crumb['id'] : undefined;
    const kind = typeof crumb['kind'] === 'string' ? crumb['kind'] : undefined;
    if (id === undefined || kind === undefined) return [];
    const label = typeof crumb['label'] === 'string' ? crumb['label'] : kind;
    return [linkTo(context, entityAddress(kind, id), label)];
  });
}

/**
 * The repository and the folders a code entity lies in, the last folder as the page's own tail: the trail ends where the
 * entity stands, never at the entity's name, which the title already states.
 */
function trailCrumbs(trail: Trail, head?: TrailCrumb): TrailCrumb[] {
  const folders = foldersOf(trail.path);
  const parent = folders.at(-1);
  const middle = [trail.repository, ...folders.slice(0, -1)].join(' / ');
  const body: TrailCrumb[] = parent === undefined
    ? [{ label: trail.repository }]
    : middle === '' ? [{ label: parent }] : [{ label: middle }, { label: parent }];
  return head === undefined ? body : [head, ...body];
}

/** The repository and the folders a code entity lies in: the trail the template named, less the page's own path. */
function trailOf(trail: unknown, data: unknown): Trail | null {
  if (typeof trail !== 'object' || trail === null) return null;
  const held = trail as TrailParams;
  const repository = typeof held.repository === 'string' ? valueAt(data, held.repository) : undefined;
  const path = typeof held.path === 'string' ? valueAt(data, held.path) : undefined;
  if (typeof repository !== 'string' || repository === '') return null;
  return { repository, path: typeof path === 'string' ? path : '' };
}

/**
 * The name a page's header gives it, or null when the template has no header or the header names the product: the tab
 * bar and the browser's own title take it, so the page is read by the name its reader sees above it.
 */
export function pageTitleOf(composition: PageComposition, data: Readonly<Record<string, unknown>>, language: string): string | null {
  const header = composition.sections.find((one) => one.component === 'header');
  if (header === undefined) return null;
  const params = header.params;
  // A page that names the product itself (the home) is named by the product in the frame's own words.
  if (params['productTitle'] === true) return null;
  const titlePath = typeof params['titlePath'] === 'string' ? params['titlePath'] : 'label';
  const held = data[header.id];
  const trail = trailOf(params['trail'], held);
  const title = (trail === null ? undefined : lastSegment(trail.path)) ?? textOf(valueAt(held, titlePath)) ?? titleIn(header.title, language) ?? '';
  return title === '' ? null : title;
}

function foldersOf(path: string): string[] {
  return path.split('/').filter((one) => one !== '').slice(0, -1);
}

/** The file a path names: its last segment, or nothing where the path is empty. */
function lastSegment(path: string): string | undefined {
  return path.split('/').filter((one) => one !== '').at(-1);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
