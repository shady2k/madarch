import { KLink } from './blocks.js';
import { ShellSidebar, ShellMain, ShellFixed, ShellRow, ShellScroll, ShellDocument, ShellToolbar, ShellActions, ShellBreadcrumb, ShellBreadcrumbSeparator, ShellTabs, ShellTab, ShellTabTrigger, ShellTabClose, ShellMenuButton, ShellError, ShellStatusButton, ShellStatusWrap, ShellStatusLabel, ShellStatusWords, ShellStatusCount, ShellStatusBody, ShellStatusLine, ShellStatusMessage, ShellStatusDot, ShellBrandMark, ShellProductMenu, ShellProductLink, ShellLanguageButton, ShellFillContent, ShellFillChoice, ShellHomeLink, ShellAnswersLink, ShellAnswersWords, ShellAnswersCount, ShellNavigationLoading, ShellToolbarLoading, ShellNavigationSheet } from '@/components/ui/shell.js';
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
import { AlertTriangleIcon, BookOpenIcon, CheckIcon, FolderGit2Icon, GlobeIcon, HomeIcon, LayoutGridIcon, MenuIcon, PauseIcon, SettingsIcon, SquareIcon, XIcon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { setWikiLanguage, type WikiLanguage } from '../i18n.js';
import { navigateTo } from '../hold.js';
import { activateTab, closeTab, linkHandlers, useTabs } from './tabs.js';
import { Badge } from '@/components/ui/badge.js';
import { Sheet, SheetTrigger } from '@/components/ui/sheet.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu.js';
import { getProducts } from './api.js';
import { Card } from '@/components/ui/card.js';
import { RunControls, runIsPaused, runIsStopped } from './run-controls.js';
import { CataloguePage, DocumentPage, DocumentsPage, EntityPage, EmptyHome, FillCard, KindPage, NewHome, SourcePage, StatementPage, Overview } from './pages.js';
import { FillPage } from './fill-page.js';
import { RunPage } from './repository.js';
import { unitName } from './writer.js';
import { GlossaryProvider, GlossaryPage } from './glossary.js';
import { HelpLink, RoleCard, RoleMenu } from './role-ui.js';
import { RoleContext, leadGroups, loadSettings, useRole, useSettings } from './roles.js';
import { addressOfKind, WIKI_CATALOGUE, WIKI_DOCS, WIKI_FILL, WIKI_GLOSSARY, WIKI_HOME, WIKI_PROBLEMS, WIKI_QUESTIONS, WIKI_SETTINGS, wikiRouteOf, type WikiRoute } from './routes.js';
import { ProblemsPage } from './loop.js';
import { JournalPage } from './journal.js';
import { KindLabels, useKindName } from './kind-names.js';
import { PageSkeleton } from './skeleton.js';
import { fillWords } from './fill-words.js';
import { FailureNote } from './errors.js';
import type { KindSummary, ProductChoice, WikiStatus } from './types.js';
import { useWikiStatus } from './live.js';
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
 * sub-areas in the manifest's order. `kinds` holds every kind the group shows,
 * sub-areas included, so a role that leads a group keeps its whole branch.
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

/** The kinds of the manifest as the navigation shows them: top-level groups, each with its sub-areas, in the manifest's order. */
export function navGroups(status: WikiStatus, pending: (kind: string) => number): NavGroup[] {
  // A group counts every entity of its kinds, the home page included, so the navigation and the catalogue say the same number.
  const counted = status.kinds.filter((kind) => !inLoop(kind));
  const shown = status.kinds.filter((kind) => kind.page !== false && !inLoop(kind) && !hasOwnPlace(kind) && !kind.single && (kind.origins.includes('person') || kind.count > 0 || pending(kind.kind) > 0));
  const declared = status.groups.map((group) => ({ group: group.group as string | null, labels: group.labels as Record<string, string> | null, short: group.short as Record<string, string> | undefined, parent: group.parent, open: group.open === true }));
  const known = new Set(status.groups.map((group) => group.group));
  const top = declared.filter((group) => group.parent === undefined || !known.has(group.parent));
  const children = declared.filter((group) => group.parent !== undefined && known.has(group.parent));
  const belongs = (kind: KindSummary, group: string | null): boolean => (group === null ? kind.group === undefined || !known.has(kind.group) : kind.group === group);
  const countedOf = (group: string | null): number => counted.filter((kind) => belongs(kind, group)).reduce((sum, kind) => sum + kind.count, 0);
  const shownOf = (group: string | null): KindSummary[] => shown.filter((kind) => belongs(kind, group));
  const loose = shownOf(null);
  const all = loose.length > 0 ? [...top, { group: null, labels: null, short: undefined, parent: undefined, open: false }] : top;
  return all
    .map((entry): NavGroup => {
      const childrenOf = entry.group === null ? [] : children.filter((child) => child.parent === entry.group);
      // A sub-area counts every entity of its kinds, as the parent does, even when none has a navigation row.
      const subgroups = childrenOf.map((child): NavSubgroup => ({ group: child.group!, labels: child.labels!, ...(child.short === undefined ? {} : { short: child.short }), total: countedOf(child.group), kinds: shownOf(child.group) }));
      const childKindNames = new Set(subgroups.flatMap((child) => child.kinds.map((kind) => kind.kind)));
      const direct = shownOf(entry.group).filter((kind) => !childKindNames.has(kind.kind));
      const kinds = entry.group === null ? shownOf(null) : [...direct, ...subgroups.flatMap((child) => child.kinds)];
      return { group: entry.group, labels: entry.labels, ...(entry.short === undefined ? {} : { short: entry.short }), open: entry.open, total: countedOf(entry.group) + subgroups.reduce((sum, child) => sum + child.total, 0), kinds, subgroups };
    });
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
  const groups = leadGroups(navGroups(status, pendingOf), role, roles);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const pick = (address: string) => linkHandlers(address, onNavigate);
  const waitingLink = (id: string, href: string, Icon: typeof HomeIcon, label: string, count: number, active: boolean): ReactElement => (
    <NavigationLink
      href={appPath(href)}
      active={active} empty={count === 0}
      aria-current={active ? 'page' : undefined}
      data-empty={count === 0 ? 'true' : 'false'}
      data-testid={id}
      {...pick(href)}
    >
      <Icon aria-hidden="true" size={16} />
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
      <NavigationLink key={kind.kind} href={appPath(address)} active={active} depth={depth} aria-current={active ? 'page' : undefined} data-nav-kind={kind.kind} {...pick(address)}>
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
        <NavigationLink href={appPath(WIKI_HOME)} active={route.name === 'home'} aria-current={route.name === 'home' ? 'page' : undefined} data-testid="nav-home" {...pick(WIKI_HOME)}>
          <HomeIcon aria-hidden="true" size={16} />
          <NavigationLabel>{t('knowledge.home')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink href={appPath(WIKI_CATALOGUE)} active={route.name === 'catalogue'} aria-current={route.name === 'catalogue' ? 'page' : undefined} data-testid="nav-catalogue" {...pick(WIKI_CATALOGUE)}>
          <LayoutGridIcon aria-hidden="true" size={16} />
          <NavigationLabel>{t('navigation.catalogue')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink href={appPath(WIKI_GLOSSARY)} active={route.name === 'glossary'} aria-current={route.name === 'glossary' ? 'page' : undefined} data-testid="nav-glossary" {...pick(WIKI_GLOSSARY)}>
          <BookOpenIcon aria-hidden="true" size={16} />
          <NavigationLabel>{t('knowledge.glossary.title')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink href={appPath(WIKI_FILL)} active={route.name === 'fill'} aria-current={route.name === 'fill' ? 'page' : undefined} data-testid="nav-fill" {...pick(WIKI_FILL)}>
          <NavigationLabel>{t('navigation.fill')}</NavigationLabel>
        </NavigationLink>
        <NavigationSection data-testid="nav-waiting">
          <NavigationHeading>{t('knowledge.waiting')}</NavigationHeading>
          {waitingLink('nav-problems', WIKI_PROBLEMS, AlertTriangleIcon, t('loop.problemsTitle'), problemsOpen, route.name === 'problems')}
        </NavigationSection>
        {groups.length > 0 && <NavigationHeading>{t('knowledge.kinds')}</NavigationHeading>}
        {groups.map((entry) => {
          const key = entry.group ?? '\0other';
          const holdsActive = route.name === 'kind' && entry.kinds.some((kind) => kind.kind === route.kind);
          const open = opened[key] ?? (holdsActive || entry.open);
          return (
            <NavigationGroup key={key} data-nav-group={entry.group ?? ''}>
              <NavigationGroupTrigger open={open} empty={entry.total === 0} data-empty={entry.total === 0} onClick={() => setOpened({ ...opened, [key]: !open })} data-testid="nav-group">
                <NavigationLabel>{entry.labels === null ? t('knowledge.groupOther') : entry.short?.[language] ?? entry.labels[language] ?? entry.labels['en'] ?? entry.group}</NavigationLabel>
                <NavigationCount data-testid="nav-group-count">{entry.total}</NavigationCount>
              </NavigationGroupTrigger>
              {open && (
                <>
                  {directOf(entry).map((kind) => kindLink(kind))}
                  {entry.subgroups.map((subgroup) => (
                    <NavigationGroup key={subgroup.group} data-nav-subgroup={subgroup.group} data-testid="nav-subgroup">
                      <NavigationSubheading empty={subgroup.total === 0} data-empty={subgroup.total === 0}>
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
        <NavigationLink href={appPath(WIKI_DOCS)} active={route.name === 'docs' || route.name === 'doc'} aria-current={route.name === 'docs' || route.name === 'doc' ? 'page' : undefined} data-testid="nav-documents" {...pick(WIKI_DOCS)}>
          <FolderGit2Icon aria-hidden="true" size={16} />
          <NavigationLabel>{t('knowledge.documents')}</NavigationLabel>
        </NavigationLink>
        {status.own !== true && (
          <NavigationLink href={appPath(WIKI_SETTINGS)} active={route.name === 'settings'} aria-current={route.name === 'settings' ? 'page' : undefined} data-testid="nav-settings" {...pick(WIKI_SETTINGS)}>
            <SettingsIcon aria-hidden="true" size={16} />
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

/** The pages the product holds, for the status line: the Markdown kinds' entities. */
function pagesOf(status: WikiStatus): number {
  return status.kinds.filter((kind) => kind.source === 'markdown' && !inLoop(kind)).reduce((sum, kind) => sum + kind.count, 0);
}

/**
 * The fill status and current run controls. Starting a fill belongs to /fill;
 * the toolbar menu only links there.
 */
export function FillMenu({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement | null {
  const { t, i18n } = useTranslation();
  // The badge's panel is a plain dialog in the toolbar, not a menu with a portal of its own: a badge is a button, and
  // what it opens is reached by the keyboard (madarch-m38l.23) — Tab from the badge opens it and moves into it, Escape
  // closes it and puts focus back on the badge. Its height is what the window leaves beside the badge, and the words
  // that do not fit scroll inside it instead of reaching past the bottom of the window.
  const chip = useRef<HTMLButtonElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const focusPanel = useRef(false);
  const [open, setOpen] = useState(false);
  /** The menu opened by the status badge. */
  const panelNode = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="fill-menu"]');
  const openPanel = (): void => {
    setOpen(true);
    focusPanel.current = true;
  };
  // The first thing the panel offers takes focus when it opens, so Tab from the badge lands on a real control.
  useEffect(() => {
    if (!open || !focusPanel.current) return;
    focusPanel.current = false;
    panelNode()?.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([disabled])')?.focus();
  }, [open]);
  // A press anywhere else closes it, and so does tabbing out of it.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelNode()?.contains(target) === true || chip.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => { document.removeEventListener('pointerdown', outside, true); };
  }, [open]);
  const fill = status.fill;
  const writer = status.writer;
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  if (status.manifest !== 'ok') return null;
  // The stages of the agent named the way a reader knows them: the kind's name and the page's title (madarch-m38l.23).
  // A run a person holds or ended is read before the stages (madarch-m38l.17): a paused one writes nothing, and «Заполнено»
  // would be a lie about a run that stands ready to be taken up.
  const paused = runIsPaused(status);
  const stopped = runIsStopped(status);
  const authoring = !paused && (writer.state === 'running' || writer.state === 'waiting');
  // A graph fill is a live run too: no agent, no pages counted yet, but a person can still pause or stop it (madarch-m38l.17).
  const filling = !paused && !stopped && fill.state === 'running';
  const written = writer.units.filter((unit) => unit.state === 'written').length;
  // How far the agent is, of the pages this run means to write: «Агент пишет страницы · 12/18». The total comes from the
  // writer before its first unit and grows only when the product page declares more domains; until it is there the count
  // stands alone («12»), never against a denominator made of what has merely been taken up.
  const count = `${written}${writer.total === undefined ? '' : `/${writer.total}`}`;
  const current = writer.units.find((unit) => unit.unit === writer.current) ?? writer.units.find((unit) => unit.state === 'writing');
  const currentName = current === undefined ? null : unitName(current, status.kinds, language);
  let label: string;
  let solid = false;
  /** The badge's phone-width form, when the whole sentence does not fit there; null keeps the sentence alone. */
  let narrow: string | null = null;
  const pagesTotal = writer.total;
  if (paused) label = pagesTotal === undefined ? t('knowledge.fillPage.paused') : t('knowledge.fillPage.pausedCount', { done: written, total: pagesTotal });
  else if (stopped) label = pagesTotal === undefined ? t('knowledge.fillPage.stopped') : t('knowledge.fillPage.stoppedCount', { done: written, total: pagesTotal });
  else if (fill.state === 'running') { label = fillWords(fill, t); solid = true; }
  else if (fill.state === 'failed') label = t('knowledge.fillFailed');
  else if (authoring) {
    label = writer.units.length === 0 ? t('knowledge.fillWriting') : `${t('knowledge.fillWriting')} · ${count}`;
    solid = true;
  }
  else if (status.filled) label = t('knowledge.sync');
  // A product with a repository and no fill yet offers Fill in the top bar (the owner, 2026-11-10): the press opens the
  // setup page, where the person chooses the sections and the agent and reads the estimate before pressing. A
  // product with no repository has nothing to fill and says so on its home page instead.
  else if (status.repositories.length > 0) { label = t('knowledge.fillButton'); solid = true; }
  else return null;
  // Below a phone's width the badge is its state's mark and the count on one line; its name and the popover keep the
  // whole sentence. A held or ended run has its figures in its sentence, so its count stands only where the words go.
  const compact = authoring && writer.units.length > 0;
  const held = (paused || stopped) && writer.units.length > 0;
  return (
    <ShellStatusWrap
      ref={wrap}
      onKeyDown={(event) => {
        // Escape gives the badge back its focus, wherever in the panel it was pressed.
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        chip.current?.focus();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!open || next === null || wrap.current?.contains(next) === true) return;
        setOpen(false);
      }}
    >
      <ShellStatusButton
        ref={chip}
        type="button"
        compact={compact}
        data-testid="fill-chip"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="fill-menu-panel"
        title={authoring ? label : t('knowledge.fillMenuTitle')}
        onClick={() => { if (open) setOpen(false); else openPanel(); }}
        onKeyDown={(event) => {
          // Tab from the closed badge opens the panel and lands on its first control; it never swallows a Tab elsewhere.
          if (open || event.shiftKey || (event.key !== 'Tab' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          openPanel();
        }}
      >
        <Badge variant={solid ? 'solid' : 'outline'}>
          <FillDot status={status} />
          {paused && <PauseIcon aria-hidden="true" className="fill-chip-state-icon mr-1 size-3.5" data-testid="fill-chip-pause" />}
          {stopped && <SquareIcon aria-hidden="true" className="fill-chip-state-icon mr-1 size-3" data-testid="fill-chip-stop" />}
          <ShellStatusLabel>
            {compact
              ? <><ShellStatusWords>{t('knowledge.fillWriting')} · </ShellStatusWords><ShellStatusCount>{count}</ShellStatusCount></>
              : held
                ? <><ShellStatusWords>{label}</ShellStatusWords><ShellStatusCount narrow>{count}</ShellStatusCount></>
                : narrow === null
                  ? label
                  : <><ShellStatusWords>{label}</ShellStatusWords><ShellStatusCount narrow>{narrow}</ShellStatusCount></>}
          </ShellStatusLabel>
        </Badge>
      </ShellStatusButton>
      {open && (
        <Card id="fill-menu-panel" role="dialog" aria-label={t('knowledge.fillMenuTitle')} data-testid="fill-menu" floating>
          <ShellFillContent>
            <ShellFillChoice href={appPath(WIKI_FILL)} {...linkHandlers(WIKI_FILL)} data-testid="fill-menu-choose" >{t('knowledge.fillChoose')}</ShellFillChoice>
            {(authoring || filling) && (
              // While the agent writes or the graph is read: the whole sentence and, when there is one, what is being written
              // now, and the way to the fill page (never the paths: the menu is anchored to the top bar and must stay inside
              // a narrow viewport). A fill with no agent still offers the two presses here (madarch-m38l.17).
              <ShellStatusBody data-testid="fill-menu-live">
                <ShellStatusLine data-testid="fill-menu-total">{label}</ShellStatusLine>
                {authoring && <ShellStatusLine data-testid="fill-menu-current">{currentName === null ? t('knowledge.fillPage.waiting') : t('knowledge.fillPage.writingNow', { name: currentName })}</ShellStatusLine>}
                <ShellStatusLine><KLink href={WIKI_FILL} testId="fill-menu-open">{t('knowledge.fillPage.open')}</KLink></ShellStatusLine>
                <RunControls status={status} refresh={refresh} where="menu" />
              </ShellStatusBody>
            )}
            {paused && (
              // The run stands where the person left it: what it wrote, the way to its page, and the two presses that take it
              // up again or end it (madarch-m38l.17).
              <ShellStatusBody data-testid="fill-menu-paused">
                <ShellStatusLine data-testid="fill-menu-total">{label}</ShellStatusLine>
                <ShellStatusLine><KLink href={WIKI_FILL} testId="fill-menu-open">{t('knowledge.fillPage.open')}</KLink></ShellStatusLine>
                <RunControls status={status} refresh={refresh} where="menu" />
              </ShellStatusBody>
            )}
            {!authoring && writer.units.length > 0 && <ShellStatusLine inset data-testid="fill-menu-open-line"><KLink href={WIKI_FILL} testId="fill-menu-open">{t('knowledge.fillPage.open')}</KLink></ShellStatusLine>}
            {writer.asked !== undefined && writer.asked > 0 && <ShellStatusLine inset data-testid="fill-menu-asked">{t('loop.agentAsked', { count: writer.asked })}</ShellStatusLine>}
            {writer.message !== undefined && <ShellStatusMessage data-testid="fill-menu-message"><FailureNote scope="writer" code={writer.code ?? (writer.state === 'done' ? 'note' : undefined)} message={writer.message} /></ShellStatusMessage>}
            {fill.message !== undefined && fill.state === 'failed' && <ShellStatusMessage><FailureNote scope="fill" code={fill.code} message={fill.message} /></ShellStatusMessage>}
          </ShellFillContent>
        </Card>
      )}
    </ShellStatusWrap>
  );
}

export function Toolbar({ status, route, menu, refresh, products, current }: { status: WikiStatus; route: WikiRoute; menu: ReactNode; refresh: () => void; products: readonly ProductChoice[]; current: string | null }): ReactElement {
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
        {status.own !== true && <FillMenu status={status} refresh={refresh} />}
        <RoleMenu />
        <HelpLink products={products} current={current} />
        <LanguageMenu />
      </ShellActions>
    </ShellToolbar>
  );
}

/** The fill's state as the header's dot tells it (madarch-stm0.6, the owner 2026-11-10). */
export type FillDotState = 'up-to-date' | 'stale' | 'running' | 'failed';

/**
 * Which of the four states a product's fill stands in: a run under way, a run that failed, the graph short of what the
 * checkouts hold (some files or commits are not read), or up to date. The app reads only the status: the engine keeps no
 * second copy of this answer.
 */
export function fillDotState(status: WikiStatus): FillDotState {
  if (status.fill.state === 'running' || status.writer.state === 'running' || status.writer.state === 'waiting') return 'running';
  if (status.fill.state === 'failed' || status.writer.state === 'failed') return 'failed';
  if (status.incomplete || status.repositories.some((repository) => !repository.filled)) return 'stale';
  return 'up-to-date';
}

/**
 * The dot's words: the commit the graph describes and the counts the run published, in the reader's language. A state
 * without a commit says so rather than naming an empty one.
 */
export function fillDotTitle(status: WikiStatus, t: (key: string, args?: Record<string, string | number>) => string): string {
  const commit = status.repository?.asIsCommit ?? null;
  const short = commit === null ? null : commit.slice(0, 7);
  const counts = status.fill.counts ?? status.repository?.counts;
  const figures = { files: counts?.files ?? 0, commits: counts?.commits ?? 0 };
  const state = fillDotState(status);
  if (state === 'running') return short === null ? t('knowledge.fillDot.runningNoCommit', figures) : t('knowledge.fillDot.running', { ...figures, commit: ` at ${short}` });
  if (state === 'failed') return t('knowledge.fillDot.failed');
  if (state === 'stale') return short === null ? t('knowledge.fillDot.staleNoCommit', figures) : t('knowledge.fillDot.stale', { ...figures, commit: short });
  return short === null ? t('knowledge.fillDot.upToDateNoCommit', figures) : t('knowledge.fillDot.upToDate', { ...figures, commit: short });
}

/**
 * The one dot on the Fill/Sync button: a filled dot when the graph stands up to date, a hollow one when it is stale, a
 * pulsing one while a run works and a barred one when a run failed. The state is told by its shape and its word, never by
 * hue (the design tokens are the graphite pair), and its title says the commit and the counts.
 */
export function FillDot({ status }: { status: WikiStatus }): ReactElement {
  const { t, i18n } = useTranslation();
  const state = fillDotState(status);
  let words = fillDotTitle(status, t);
  if (status.filled && (state === 'up-to-date' || state === 'stale') && !runIsPaused(status) && !runIsStopped(status)) {
    const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
    const when = status.fill.finishedAt;
    if (when !== undefined) words += ` · ${t('knowledge.fillDot.finished', { date: new Date(when).toLocaleDateString(language, { day: 'numeric', month: 'short', timeZone: 'UTC' }) })}`;
    words += ` · ${t('knowledge.fillDot.pages', { count: pagesOf(status) })}`;
    if (status.fill.rebuilt === 'extractors-changed') words += ` · ${t('knowledge.fillRebuiltExtractors')}`;
  }
  return (
    <ShellStatusDot state={state} data-testid="fill-dot" data-state={state} title={words} aria-label={words} role="img" />
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
  const contentPage = !['kind', 'catalogue', 'dependencies', 'settings', 'fill', 'run', 'journal'].includes(route.name);
  let view: ReactElement;
  // No store, no home page: until a fill runs the home is the introduction, even when the product repository holds a
  // page a later stage will read. Nothing of the product is parsed before the fill writes it.
  if (route.name === 'home') view = !status.filled
    ? <Overview status={status} refresh={refresh} />
    : status.home !== null
      ? <EntityPage key={status.home} id={status.home} version={version} />
      : status.repository !== undefined && status.repository.asIsCommit !== null
        ? <EntityPage key={status.repository.id} id={status.repository.id} after={null} version={version} />
        : <Overview status={status} refresh={refresh} />;
  else if (route.name === 'kit') view = <KitPage />;
  else if (route.name === 'entity') view = <EntityPage key={`${route.id}\0${route.after ?? ''}`} id={route.id} after={route.after} version={version} />;
  else if (route.name === 'authored') view = status.kinds.some((kind) => kind.kind === route.kind && kind.origins.includes('person')) ? <AuthoredPage key={`${route.kind}:${route.uid}`} kind={route.kind} uid={route.uid} version={version} /> : <p>{t('knowledge.noSuchPage')}</p>;
  else if (route.name === 'kind') view = <KindPage key={route.kind} kind={route.kind} version={version} />;
  else if (route.name === 'problems') view = <ProblemsPage version={version} refresh={refresh} />;
  else if (route.name === 'settings') view = <SettingsPage version={version} status={status} refresh={refresh} />;
  else if (route.name === 'journal') view = <JournalPage key={`${route.id}\0${route.run ?? ''}`} id={route.id} run={route.run} version={version} />;
  else if (route.name === 'fill') view = <FillPage status={status} refresh={refresh} />;
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
            <Toolbar status={status} route={route} menu={menu} refresh={refresh} products={products} current={currentFolder} />
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

