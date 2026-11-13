
import { ShellSidebar, ShellMain, ShellFixed, ShellRow, ShellScroll, ShellDocument, ShellToolbar, ShellActions, ShellBreadcrumb, ShellBreadcrumbSeparator, ShellTabs, ShellTab, ShellTabTrigger, ShellTabClose, ShellMenuButton, ShellError, ShellBrandMark, ShellProductMenu, ShellProductLink, ShellLanguageButton, ShellHomeLink, ShellAnswersLink, ShellAnswersWords, ShellAnswersCount, ShellNavigationLoading, ShellToolbarLoading, ShellNavigationSheet } from '@/components/ui/shell.js';
import { NavigationLink, NavigationLabel, NavigationCount, NavigationPending, NavigationScroll, NavigationSection, NavigationHeading, NavigationGroup, NavigationGroupTrigger, NavigationSubheading, NavigationFooter, ProductButton, BrandLink } from '@/components/ui/navigation.js';
import { Stack, Text, Paragraph } from '@/components/ui/typography.js';
import { AuthoredPage } from './authored.js';
/**
 * The knowledge wiki (decision 0029): the product chosen at the top left, the
 * kinds the product's manifest declares, and the page of one entity at a time
 * drawn from the server's page model. The app holds no kind, no template and no
 * page of its own: an empty product says what to do, and a fill that runs while
 * the page is open is read again as each commit lands.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangleIcon, BookOpenIcon, CheckIcon, FolderGit2Icon, FolderIcon, FileTextIcon, RefreshCwIcon, GlobeIcon, HomeIcon, LayoutGridIcon, MenuIcon, SettingsIcon, XIcon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { setWikiLanguage, type WikiLanguage } from '../i18n.js';
import { navigateTo } from '../hold.js';
import { activateTab, closeTab, linkHandlers, useTabs } from './tabs.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Sheet, SheetTrigger } from '@/components/ui/sheet.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu.js';
import { getFillRun, getProducts } from './api.js';

import { CataloguePage, DocumentPage, DocumentsPage, EntityPage, EmptyHome, FillCard, KindPage, NewHome, SourcePage, StatementPage, Overview } from './pages.js';
import { FillPage } from './fill-page.js';
import { SelectionRunPage } from './fill-runs.js';
import { RunPage } from './repository.js';

import { GlossaryProvider, GlossaryPage } from './glossary.js';
import { FactsHome } from './facts.js';
import { HelpLink, RoleCard, RoleMenu } from './role-ui.js';
import { RoleContext, leadGroups, loadSettings, useRole, useSettings } from './roles.js';
import { addressOfFillRun, addressOfKind, WIKI_CATALOGUE, WIKI_DOCS, WIKI_FILL, WIKI_GLOSSARY, WIKI_HOME, WIKI_PROBLEMS, WIKI_QUESTIONS, WIKI_SETTINGS, wikiRouteOf, type WikiRoute } from './routes.js';
import { ProblemsPage } from './loop.js';
import { JournalPage } from './journal.js';
import { KindLabels, useKindName } from './kind-names.js';
import { PageSkeleton } from './skeleton.js';


import type { KindSummary, ProductChoice, WikiStatus } from './types.js';
import { useRead, useWikiStatus } from './live.js';
import { PendingPages } from './pending.js';
import { SettingsPage } from './settings.js';
import { KitPage } from './kit-page.js';
import { SearchBox } from './search.js';

/**
 * Where the fill's card sits: the product's own page and the pages of its entities. The catalogue, a statement, a source,
 * the loop's pages and the settings are other places, so a fill that runs, fails or waits for a press is not drawn above
 * them (the top bar's chip says the same everywhere). The overview, which has no home page, draws the card itself.
 */
export function showsProgress(route: WikiRoute, status: WikiStatus): boolean {
  // The repository page is the home once the store holds a repository (madarch-8bdc.2.5, item 3); a
  // fill that runs there, or fails there, still draws its card, so the press and its progress stay
  // where the reader is. With no store the home is the introduction, which draws its own fill card:
  // one card, never two.
  if (route.name === 'home') return status.filled && (status.home !== null || status.fill.state === 'running' || status.fill.state === 'failed');
  return route.name === 'entity';
}

/** The loop's kinds have their own places («Вопросы», «Проблемы»), not a kind page of their own: the manifest says which (`nav: loop`). */
const inLoop = (kind: KindSummary): boolean => !kind.origins.includes('person') && kind.nav === 'loop';

/** The choices the selector offers: each product's wiki address, and which one is open. */
export function productChoices(products: readonly ProductChoice[], current: string | null): { name: string; folder: string; href: string; here: boolean }[] {
  return products.map((product) => ({ name: product.name, folder: product.folder, href: `/products/${encodeURIComponent(product.folder)}${WIKI_HOME}`, here: product.folder === current }));
}

/** The product at the top left: its name, and the other products of this server to choose from. */
export function ProductSelector({ name, products, current }: { name: string; products: readonly ProductChoice[]; current: string | null; own?: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ProductButton name={name} description={t('product.space')} data-testid="product-selector" aria-label={t('knowledge.chooseProduct')} />
      </DropdownMenuTrigger>
      <ShellProductMenu align="start">
        <DropdownMenuLabel>{t('knowledge.products')}</DropdownMenuLabel>
        {productChoices(products, current).map((product) => {
          const here = product.here;
          return (
            <DropdownMenuItem key={product.folder} asChild>
              <ShellProductLink
                href={product.href}
                data-testid="product-choice"
                aria-current={here ? 'true' : undefined}
                onClick={(event) => {
                  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
                  if (here) {
                    event.preventDefault();
                    navigateTo(appPath(WIKI_HOME));
                  }
                }}
              >
                <NavigationLabel>{product.name}</NavigationLabel>
                {here && <CheckIcon aria-hidden="true" size={16} />}
              </ShellProductLink>
            </DropdownMenuItem>
          );
        })}
        {products.length === 0 && <DropdownMenuItem disabled>{name}</DropdownMenuItem>}
      </ShellProductMenu>
    </DropdownMenu>
  );
}

/**
 * The kinds whose entities stand at a place the loop draws for itself (`nav: own-page`), such as the tasks: "Pages by
 * kind" does not list them again. A kind that declares its own listing page (`listing:`) is not one of them: its row
 * stands in its manifest group and opens that listing, so the navigation places it like every other kind.
 */
const hasOwnPlace = (kind: KindSummary): boolean => !kind.origins.includes('person') && kind.nav === 'own-page' && kind.listing === undefined;

/** The address a kind's row opens: its own listing page when the manifest declares one, else its page by kind. */
const ownAddressOf = (kind: KindSummary): string => !kind.origins.includes('person') && kind.listing === 'glossary' ? WIKI_GLOSSARY : addressOfKind(kind.kind);

/** Whether the kind's own listing page is the page in front. */
const ownRouteOf = (kind: KindSummary, route: WikiRoute): boolean => !kind.origins.includes('person') && kind.listing === 'glossary' ? route.name === 'glossary' : route.name === 'kind' && route.kind === kind.kind;

/** A sub-area of a group, as the navigation and the catalogue draw it. */
interface NavSubgroup {
  group: string;
  labels: Record<string, string>;
  /** The navigation's short label per language; the full name when it is absent. */
  short?: Record<string, string>;
  total: number;
  kinds: KindSummary[];
}

/**
 * A group of the navigation: its direct kinds and, when it has sub-areas, those
 * sub-areas with populated entries first, in declared order. `kinds` holds
 * every kind the group shows, sub-areas included.
 */
interface NavGroup {
  group: string | null;
  labels: Record<string, string> | null;
  /** The navigation's one-or-two-word label per language; the full name when it is absent. */
  short?: Record<string, string>;
  /** The manifest's `open: true`: the menu opens this group by itself, before a reader touches it. */
  open: boolean;
  total: number;
  kinds: KindSummary[];
  subgroups: NavSubgroup[];
}

/** Keep the manifest order within populated and empty entries. */
const populatedFirst = <T,>(entries: readonly T[], count: (entry: T) => number): T[] => [...entries.filter((entry) => count(entry) > 0), ...entries.filter((entry) => count(entry) === 0)];

/** Navigation groups and sub-areas, with populated siblings first and declared order preserved within each set. */
export function navGroups(status: WikiStatus): NavGroup[] {
  // A group counts every entity of its kinds, the home page included, so the navigation and the catalogue say the same number.
  const counted = status.kinds.filter((kind) => !inLoop(kind));
  const shown = status.kinds.filter((kind) => kind.page !== false && !inLoop(kind) && !hasOwnPlace(kind) && !kind.single);
  const declared = status.groups.map((group) => ({ group: group.group as string | null, labels: group.labels as Record<string, string> | null, short: group.short as Record<string, string> | undefined, parent: group.parent, open: group.open === true }));
  const known = new Set(status.groups.map((group) => group.group));
  const top = declared.filter((group) => group.parent === undefined || !known.has(group.parent));
  const children = declared.filter((group) => group.parent !== undefined && known.has(group.parent));
  const belongs = (kind: KindSummary, group: string | null): boolean => (group === null ? kind.group === undefined || !known.has(kind.group) : kind.group === group);
  const countedOf = (group: string | null): number => counted.filter((kind) => belongs(kind, group)).reduce((sum, kind) => sum + kind.count, 0);
  const shownOf = (group: string | null): KindSummary[] => populatedFirst(shown.filter((kind) => belongs(kind, group)), (kind) => kind.count);
  const loose = shownOf(null);
  const all = loose.length > 0 ? [...top, { group: null, labels: null, short: undefined, parent: undefined, open: false }] : top;
  return populatedFirst(all
    .map((entry): NavGroup => {
      const childrenOf = entry.group === null ? [] : children.filter((child) => child.parent === entry.group);
      // A sub-area counts every entity of its kinds, as the parent does, even when none has a navigation row.
      const subgroups = populatedFirst(childrenOf.map((child): NavSubgroup => ({ group: child.group!, labels: child.labels!, ...(child.short === undefined ? {} : { short: child.short }), total: countedOf(child.group), kinds: shownOf(child.group) })), (child) => child.total);
      const childKindNames = new Set(subgroups.flatMap((child) => child.kinds.map((kind) => kind.kind)));
      const direct = shownOf(entry.group).filter((kind) => !childKindNames.has(kind.kind));
      const kinds = entry.group === null ? shownOf(null) : [...direct, ...subgroups.flatMap((child) => child.kinds)];
      return { group: entry.group, labels: entry.labels, ...(entry.short === undefined ? {} : { short: entry.short }), open: entry.open, total: countedOf(entry.group) + subgroups.reduce((sum, child) => sum + child.total, 0), kinds, subgroups };
    }), (entry) => entry.total);
}

/** Reader-purpose sections use the vocabulary order, populated pages, and the reader's explicit audience. */
export function navPurposes(status: WikiStatus, role: string) {
  const visible = status.kinds.filter((kind) => kind.count > 0 && kind.page !== false
    && (role === 'everything' || kind.audience === undefined || kind.audience.includes(role)));
  return [...(status.purposes ?? [])]
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((purpose) => ({ ...purpose, rows: purpose.kinds.flatMap((name) => visible.filter((kind) => kind.kind === name)) }))
    .filter((purpose) => purpose.rows.length > 0);
}

function NavPanel({ status, products, route, onNavigate }: { status: WikiStatus; products: readonly ProductChoice[]; route: WikiRoute; onNavigate?: () => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const kindName = useKindName();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const folder = decodeURIComponent((/^\/products\/([^/]+)/.exec(window.location.pathname)?.[1] ?? ''));
  // An older server sends only the corrections; the Problems page's own count is preferred when it is there.
  const problemsOpen = status.loop?.problemsOpen ?? status.loop?.correctionsOpen ?? 0;
  /** The pages of a kind the agent has yet to write: its units that wait or are writing (a unit is named `<kind>:<slug>`). */
  const pendingOf = (kind: string): number => status.writer.units.filter((unit) => unit.unit.startsWith(`${kind}:`) && (unit.state === 'waiting' || unit.state === 'writing')).length;
  const { role, roles } = useRole();
  const purposes = navPurposes(status, role);
  const groups = status.purposes === undefined ? leadGroups(navGroups(status), role, roles) : [];
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const pick = (address: string) => linkHandlers(address, onNavigate);
  const waitingLink = (id: string, href: string, Icon: typeof HomeIcon, label: string, count: number, active: boolean): ReactElement => (
    <NavigationLink
      icon={Icon}
      href={appPath(href)}
      active={active} empty={count === 0}
      aria-current={active ? 'page' : undefined}
      data-empty={count === 0 ? 'true' : 'false'}
      data-testid={id}
      {...pick(href)}
    >
      <NavigationLabel>{label}</NavigationLabel>
      {/* A count drawn from files is shown only once it is above zero: nothing is read until the fill runs. */}
      {count > 0 && <NavigationCount data-testid={`${id}-count`}>{count}</NavigationCount>}
    </NavigationLink>
  );
  const directOf = (entry: NavGroup): KindSummary[] => {
    const inSubgroup = new Set(entry.subgroups.flatMap((subgroup) => subgroup.kinds.map((kind) => kind.kind)));
    return entry.kinds.filter((kind) => !inSubgroup.has(kind.kind));
  };
  const kindLink = (kind: KindSummary, depth: 1 | 2 = 1): ReactElement => {
    const active = ownRouteOf(kind, route);
    const address = ownAddressOf(kind);
    return (
      <NavigationLink icon={FileTextIcon} empty={kind.count === 0} data-empty={kind.count === 0} key={kind.kind} href={appPath(address)} active={active} depth={depth} aria-current={active ? 'page' : undefined} data-nav-kind={kind.kind} {...pick(address)}>
        <NavigationLabel>{kindName(kind.kind, 'many')}</NavigationLabel>
        <NavigationCount data-testid="nav-count">
          {kind.count}
          {pendingOf(kind.kind) > 0 && <NavigationPending title={t('knowledge.pendingCount', { count: pendingOf(kind.kind) })} data-testid="nav-pending">+{pendingOf(kind.kind)}</NavigationPending>}
        </NavigationCount>
      </NavigationLink>
    );
  };
  return (
    <>
      <BrandLink href={appPath(WIKI_HOME)} data-testid="nav-brand" concept={t('brand.concept')} {...pick(WIKI_HOME)}><ShellBrandMark /></BrandLink>
      <ProductSelector name={status.product.name} products={products} current={folder === '' ? products[0]?.folder ?? null : folder} own={status.own === true} />
      <NavigationScroll aria-label={t('navigation.pages')} data-testid="nav-scroll">
        <NavigationLink icon={HomeIcon} href={appPath(WIKI_HOME)} active={route.name === 'home'} aria-current={route.name === 'home' ? 'page' : undefined} data-testid="nav-home" {...pick(WIKI_HOME)}>
          <NavigationLabel>{t('knowledge.home')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink icon={LayoutGridIcon} href={appPath(WIKI_CATALOGUE)} active={route.name === 'catalogue'} aria-current={route.name === 'catalogue' ? 'page' : undefined} data-testid="nav-catalogue" {...pick(WIKI_CATALOGUE)}>
          <NavigationLabel>{t('navigation.catalogue')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink icon={BookOpenIcon} href={appPath(WIKI_GLOSSARY)} active={route.name === 'glossary'} aria-current={route.name === 'glossary' ? 'page' : undefined} data-testid="nav-glossary" {...pick(WIKI_GLOSSARY)}>
          <NavigationLabel>{t('knowledge.glossary.title')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink icon={RefreshCwIcon} href={appPath(WIKI_FILL)} active={route.name === 'fill'} aria-current={route.name === 'fill' ? 'page' : undefined} data-testid="nav-fill" {...pick(WIKI_FILL)}>
          <NavigationLabel>{t('navigation.fill')}</NavigationLabel>
        </NavigationLink>
        <NavigationSection data-testid="nav-waiting">
          <NavigationHeading>{t('knowledge.waiting')}</NavigationHeading>
          {waitingLink('nav-problems', WIKI_PROBLEMS, AlertTriangleIcon, t('loop.problemsTitle'), problemsOpen, route.name === 'problems')}
        </NavigationSection>
        {purposes.map((purpose) => (
          <NavigationSection key={purpose.id} data-nav-purpose={purpose.id}>
            <NavigationHeading>{purpose.labels[language] ?? purpose.labels['en'] ?? purpose.id}</NavigationHeading>
            {purpose.rows.map((kind) => kindLink(kind))}
          </NavigationSection>
        ))}
        {groups.length > 0 && <NavigationHeading>{t('knowledge.kinds')}</NavigationHeading>}
        {groups.map((entry) => {
          const key = entry.group ?? '\0other';
          const holdsActive = route.name === 'kind' && entry.kinds.some((kind) => kind.kind === route.kind);
          const open = opened[key] ?? (holdsActive || entry.open);
          return (
            <NavigationGroup key={key} data-nav-group={entry.group ?? ''}>
              <NavigationGroupTrigger icon={FolderIcon} open={open} empty={entry.total === 0} data-empty={entry.total === 0} onClick={() => setOpened({ ...opened, [key]: !open })} data-testid="nav-group">
                <NavigationLabel>{entry.labels === null ? t('knowledge.groupOther') : entry.short?.[language] ?? entry.labels[language] ?? entry.labels['en'] ?? entry.group}</NavigationLabel>
                <NavigationCount data-testid="nav-group-count">{entry.total}</NavigationCount>
              </NavigationGroupTrigger>
              {open && (
                <>
                  {directOf(entry).map((kind) => kindLink(kind))}
                  {entry.subgroups.map((subgroup) => (
                    <NavigationGroup key={subgroup.group} data-nav-subgroup={subgroup.group} data-testid="nav-subgroup">
                      <NavigationSubheading icon={FolderIcon} empty={subgroup.total === 0} data-empty={subgroup.total === 0}>
                        <NavigationLabel>{subgroup.short?.[language] ?? subgroup.labels[language] ?? subgroup.labels['en'] ?? subgroup.group}</NavigationLabel>
                        <NavigationCount data-testid="nav-subgroup-count">{subgroup.total}</NavigationCount>
                      </NavigationSubheading>
                      {subgroup.kinds.map((kind) => kindLink(kind, 2))}
                    </NavigationGroup>
                  ))}
                </>
              )}
            </NavigationGroup>
          );
        })}
      </NavigationScroll>
      <NavigationFooter data-testid="nav-foot">
        <NavigationLink icon={FolderGit2Icon} href={appPath(WIKI_DOCS)} active={route.name === 'docs' || route.name === 'doc'} aria-current={route.name === 'docs' || route.name === 'doc' ? 'page' : undefined} data-testid="nav-documents" {...pick(WIKI_DOCS)}>
          <NavigationLabel>{t('knowledge.documents')}</NavigationLabel>
        </NavigationLink>
        {status.own !== true && (
          <NavigationLink icon={SettingsIcon} href={appPath(WIKI_SETTINGS)} active={route.name === 'settings'} aria-current={route.name === 'settings' ? 'page' : undefined} data-testid="nav-settings" {...pick(WIKI_SETTINGS)}>
            <NavigationLabel>{t('settings.nav')}</NavigationLabel>
          </NavigationLink>
        )}
      </NavigationFooter>
    </>
  );
}

function LanguageMenu(): ReactElement {
  const { t, i18n } = useTranslation();
  const language: WikiLanguage = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ShellLanguageButton aria-label={t('navigation.language')} title={t('tooltips.language')}>
          <GlobeIcon aria-hidden="true" size={21} />
        </ShellLanguageButton>
      </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={7}>
          <DropdownMenuLabel>{t('navigation.language')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={language} onValueChange={(value: string) => { if (value === 'en' || value === 'ru') void setWikiLanguage(value); }}>
            {(['ru', 'en'] as const).map((code) => (
              <DropdownMenuRadioItem key={code} value={code}>
                {t(code === 'ru' ? 'navigation.russian' : 'navigation.english')}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The fill entry always opens selection or the active run, never a status popover. */
export function FillButton({ status, version = 0 }: { status: WikiStatus; version?: number }): ReactElement {
  const { t } = useTranslation();
  const run = status.fill;
  const active = run.runId !== undefined && (run.state === 'running' || run.state === 'paused');
  const detail = useRead(`fill-button:${run.runId ?? ''}`, version, (signal) => active ? getFillRun(run.runId!, signal) : Promise.resolve(null)).data?.run;
  const address = active ? addressOfFillRun(run.runId!) : WIKI_FILL;
  return <Button variant="default" size="default" data-testid="fill-button" onClick={() => navigateTo(appPath(address))}>
    {active ? detail !== undefined && detail.units.length > 0 ? t('knowledge.fillRun.active', { done: detail.publishedUnits, total: detail.units.length }) : t('knowledge.fillRun.planning') : t('knowledge.fillRun.open')}
  </Button>;
}

export function Toolbar({ status, route, menu, version = 0, products, current }: { status: WikiStatus; route: WikiRoute; menu: ReactNode; refresh: () => void; version?: number; products: readonly ProductChoice[]; current: string | null }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const where = route.name === 'problems' ? t('loop.problemsTitle') : route.name === 'settings' ? t('settings.title') : route.name === 'journal' ? t('journal.title') : route.name === 'kind' ? kindName(route.kind, 'many') : route.name === 'source' ? t('knowledge.source') : route.name === 'run' ? t('knowledge.run.title') : route.name === 'docs' || route.name === 'doc' ? t('knowledge.documents') : route.name === 'catalogue' ? t('knowledge.catalogue') : route.name === 'glossary' ? t('knowledge.glossary.title') : route.name === 'statement' ? t('knowledge.statement') : route.name === 'entity' ? null : t('knowledge.home');
  return (
    <ShellToolbar>
      <ShellBreadcrumb>
        <ShellHomeLink href={appPath(WIKI_HOME)} {...linkHandlers(WIKI_HOME)} >{status.product.name}</ShellHomeLink>
        {where !== null && <><ShellBreadcrumbSeparator /><Text>{where}</Text></>}
      </ShellBreadcrumb>
      <ShellActions>
        <SearchBox />
        {status.loop !== undefined && status.loop.questionsAnswered > 0 && (
          <ShellAnswersLink href={appPath(WIKI_QUESTIONS)} {...linkHandlers(WIKI_QUESTIONS)}  data-testid="answers-waiting" title={t('loop.answersWaitingHint')}>
            <Badge variant="outline"><ShellAnswersWords>{t('loop.answersWaiting', { count: status.loop.questionsAnswered })}</ShellAnswersWords><ShellAnswersCount>{status.loop.questionsAnswered}</ShellAnswersCount></Badge>
          </ShellAnswersLink>
        )}
        {menu}
        <FillButton status={status} version={version} />
        <RoleMenu />
        <HelpLink products={products} current={current} />
        <LanguageMenu />
      </ShellActions>
    </ShellToolbar>
  );
}

/** The route an in-wiki address is; the home page for one the wiki does not know. */
function routeOfAddress(address: string): WikiRoute {
  const url = new URL(address, 'http://wiki.invalid');
  return wikiRouteOf(url.pathname, url.search) ?? { name: 'home' };
}

/** The tabs of the wiki (the first version had them): every opened page is one; the one in front is the page the address names. */
export function TabBar(): ReactElement {
  const { t } = useTranslation();
  const { tabs, active } = useTabs();
  return (
    <ShellTabs aria-label={t('knowledge.tabs')} data-testid="tab-bar">
      {tabs.map((tab) => {
        const here = tab.key === active;
        const title = tab.title ?? t('knowledge.loading');
        return (
          <ShellTab
            active={here}
            key={tab.key}
            data-testid="tab"
            data-active={here ? 'true' : 'false'}
          >
            <ShellTabTrigger
              aria-selected={here}
              title={title}
              onClick={() => activateTab(tab.key)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.key); } }}
            >
              {title}
            </ShellTabTrigger>
            {tabs.length > 1 && (
              <ShellTabClose
                aria-label={t('knowledge.closeTab', { title })}
                title={t('knowledge.closeTabShort')}
                data-testid="tab-close"
                onClick={() => closeTab(tab.key)}
              >
                <XIcon aria-hidden="true" size={14} />
              </ShellTabClose>
            )}
          </ShellTab>
        );
      })}
    </ShellTabs>
  );
}

export function KnowledgeApp(): ReactElement {
  const { t } = useTranslation();
  const tabs = useTabs();
  const frontAddress = tabs.tabs.find((tab) => tab.key === tabs.active)?.address ?? WIKI_HOME;
  const route = useMemo<WikiRoute>(() => routeOfAddress(frontAddress), [frontAddress]);
  const [products, setProducts] = useState<ProductChoice[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const { status, error, publication, version, refresh } = useWikiStatus();
  const settings = useSettings();
  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getProducts(controller.signal).then(setProducts, () => undefined);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.title = t('knowledge.title', { product: status?.product.name ?? 'madarch' });
  }, [status?.product.name, t]);
  // A page opened by a link starts at its top; a source page scrolls to its line itself.
  useEffect(() => {
    if (route.name !== 'source' && route.name !== 'doc') content.current?.scrollTo?.(0, 0);
  }, [route]);

  if (error !== null && (status === null || publication !== undefined)) {
    return <ShellError><Paragraph role={publication === 'pending' ? 'status' : 'alert'} data-testid="wiki-error" data-publication={publication}>{error}</Paragraph></ShellError>;
  }
  if (status === null) {
    return (
      <Stack layout="shell" data-testid="wiki-loading">
        <ShellSidebar loading aria-hidden="true">
          <ShellNavigationLoading />
        </ShellSidebar>
        <ShellMain>
          <ShellToolbarLoading />
          <ShellScroll data-testid="shell-content" ref={content}><ShellDocument><main><PageSkeleton testId="page-loading" /></main></ShellDocument></ShellScroll>
        </ShellMain>
      </Stack>
    );
  }
  const currentFolder = decodeURIComponent((/^\/products\/([^/]+)/.exec(window.location.pathname)?.[1] ?? '')) || (products[0]?.folder ?? null);
  const pending = new Set(status.writer.units.filter((unit) => unit.state === 'waiting' || unit.state === 'writing').map((unit) => unit.unit));
  const nav = (onNavigate?: () => void): ReactElement => <NavPanel status={status} products={products} route={route} onNavigate={onNavigate} />;
  const menu = (
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <SheetTrigger asChild>
        <ShellMenuButton aria-label={t('navigation.aria')} aria-expanded={menuOpen}>
          <MenuIcon aria-hidden="true" size={24} />
        </ShellMenuButton>
      </SheetTrigger>
      <ShellNavigationSheet side="left" title={t('navigation.aria')} closeLabel={t('navigation.close')} data-testid="phone-nav">
        {nav(() => setMenuOpen(false))}
      </ShellNavigationSheet>
    </Sheet>
  );
  const contentPage = !['kind', 'catalogue', 'dependencies', 'settings', 'fill', 'fill-run', 'run', 'journal'].includes(route.name);
  let view: ReactElement;
  // No store, no home page: until a fill runs the home is the introduction, even when the product repository holds a
  // page a later stage will read. Nothing of the product is parsed before the fill writes it.
  if (route.name === 'home') view = !status.filled
    ? <Overview status={status} refresh={refresh} />
    : <FactsHome title={status.product.name} version={version} />;
  else if (route.name === 'kit') view = <KitPage />;
  else if (route.name === 'entity') view = <EntityPage key={`${route.id}\0${route.after ?? ''}`} id={route.id} after={route.after} version={version} />;
  else if (route.name === 'authored') view = status.kinds.some((kind) => kind.kind === route.kind && kind.origins.includes('person')) ? <AuthoredPage key={`${route.kind}:${route.uid}`} kind={route.kind} uid={route.uid} version={version} /> : <p>{t('knowledge.noSuchPage')}</p>;
  else if (route.name === 'kind') view = <KindPage key={route.kind} kind={route.kind} version={version} />;
  else if (route.name === 'problems') view = <ProblemsPage version={version} refresh={refresh} />;
  else if (route.name === 'settings') view = <SettingsPage version={version} status={status} refresh={refresh} />;
  else if (route.name === 'journal') view = <JournalPage key={`${route.id}\0${route.run ?? ''}`} id={route.id} run={route.run} version={version} />;
  else if (route.name === 'fill') view = <FillPage status={status} refresh={refresh} version={version} />;
  else if (route.name === 'fill-run') view = <SelectionRunPage key={route.run} runId={route.run} version={version} refresh={refresh} />;
  else if (route.name === 'docs') view = <DocumentsPage version={version} />;
  else if (route.name === 'doc') view = <DocumentPage key={`${route.repo ?? ''}:${route.path}`} repo={route.repo} path={route.path} version={version} />;
  else if (route.name === 'catalogue') view = publication === undefined ? <CataloguePage version={version} />
    : <Paragraph role={publication === 'pending' ? 'status' : 'alert'} data-publication={publication}>{publication === 'pending' ? 'Publishing the catalogue. Please wait.' : `The catalogue could not be published: ${status.publicationMessage ?? 'see the server diagnostics'}`}</Paragraph>;
  else if (route.name === 'glossary') view = <GlossaryPage version={version} />;
  else if (route.name === 'statement') view = <StatementPage key={`${route.id}\0${route.sentence}\0${route.turn}`} id={route.id} sentence={route.sentence} turn={route.turn} version={version} />;
  else if (route.name === 'run') view = <RunPage key={route.run ?? ''} run={route.run} version={version} />;
  else view = <SourcePage key={`${route.repo ?? ''}:${route.path}`} repo={route.repo} path={route.path} line={route.line} />;
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <KindLabels.Provider value={status.kinds}>
      <RoleContext.Provider value={{ role: settings.role, roles: status.roles ?? {} }}>
      <RoleCard />
      <Stack layout="shell" data-testid="knowledge-app">
        {/* Navigation and page content have separate scroll areas within the viewport. */}
        <ShellSidebar id="app-nav" aria-label={t('navigation.aria')}>
          <Stack layout="navigation">{nav()}</Stack>
        </ShellSidebar>
        <ShellMain>
          {/* The top bar and the tab bar stay put; only the page below them scrolls. */}
          <ShellFixed data-testid="shell-fixed">
            <Toolbar status={status} route={route} menu={menu} refresh={refresh} version={version} products={products} current={currentFolder} />
            <TabBar />
          </ShellFixed>
          <ShellRow>
            <ShellScroll data-testid="shell-content" ref={content}>
              <ShellDocument>
                <main data-testid="knowledge-main">
                  {contentPage && status.manifest === 'not-filled' ? <NewHome status={status} refresh={refresh} /> : contentPage && status.manifest === 'no-manifest' ? <EmptyHome status={status} refresh={refresh} /> : (
                    <>
                      {status.own !== true && showsProgress(route, status) && <FillCard status={status} refresh={refresh} />}
                      <PendingPages.Provider value={pending}><GlossaryProvider key={frontAddress} version={version}>{view}</GlossaryProvider></PendingPages.Provider>
                    </>
                  )}
                </main>
              </ShellDocument>
            </ShellScroll>
          </ShellRow>
        </ShellMain>
      </Stack>
      </RoleContext.Provider>
      </KindLabels.Provider>
    </TooltipProvider>
  );
}

