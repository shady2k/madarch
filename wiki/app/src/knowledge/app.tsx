import { Stack } from '@/components/ui/typography.js';
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
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { AlertTriangleIcon, BookOpenIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderGit2Icon, GlobeIcon, HomeIcon, LayoutGridIcon, MenuIcon, PauseIcon, SettingsIcon, SquareIcon, XIcon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { setWikiLanguage, type WikiLanguage } from '../i18n.js';
import { navigateTo } from '../hold.js';
import { activateTab, closeTab, linkHandlers, useTabs } from './tabs.js';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { getProducts } from './api.js';
import { Card, CardContent } from '@/components/ui/card.js';
import { RunControls, runIsPaused, runIsStopped } from './run-controls.js';
import { KLink } from './blocks.js';
import { CataloguePage, DocumentPage, DocumentsPage, EntityPage, EmptyHome, FillCard, KindPage, NewHome, SourcePage, StatementPage, Overview } from './pages.js';
import { FillPage } from './fill-page.js';
import { RunPage } from './repository.js';
import { unitName } from './writer.js';
import { GlossaryContext, GlossaryPage, useGlossary, useGlossaryValue } from './glossary.js';
import { FactsHome } from './facts.js';
import { HelpLink, RoleCard, RoleMenu } from './role-ui.js';
import { RoleContext, leadGroups, loadSettings, useRole, useSettings } from './roles.js';
import { addressOfKind, WIKI_CATALOGUE, WIKI_DOCS, WIKI_FILL, WIKI_GLOSSARY, WIKI_HOME, WIKI_PROBLEMS, WIKI_QUESTIONS, WIKI_SETTINGS, wikiRouteOf, type WikiRoute } from './routes.js';
import { ProblemsPage, QuestionPage, QuestionsPage, TaskPage, TasksPage } from './loop.js';
import { JournalPage } from './journal.js';
import { KindLabels, useKindName } from './kind-names.js';
import { PageSkeleton } from './skeleton.js';
import { fillWords } from './fill-words.js';
import { FailureNote } from './errors.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import type { KindSummary, ProductChoice, WikiStatus } from './types.js';
import { useWikiStatus } from './live.js';
import { PendingPages } from './pending.js';
import { SettingsPage } from './settings.js';
import { KitPage } from './kit-page.js';
import { SearchBox } from './search.js';

/** The mockup's drawn lowercase m mark and dot, kept as one crisp vector glyph. */
function BrandMark(): ReactElement {
  return (
    <svg aria-hidden="true" className="size-[40px] shrink-0 text-ink" viewBox="0 0 50 32">
      <text x="0" y="25" fill="currentColor" fontFamily="Inter, sans-serif" fontSize="31" fontWeight="750" letterSpacing="-4">m<tspan fill="var(--text)">·</tspan></text>
    </svg>
  );
}

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
        <button
          type="button"
          data-testid="product-selector"
          aria-label={t('knowledge.chooseProduct')}
          className="nav-product-block mb-3 flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-card)] border border-line bg-[var(--surface-card)] px-[9px] py-2 text-left shadow-[var(--shadow-low)] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
        >
          <span aria-hidden="true" className="product-initial grid size-[40px] shrink-0 place-items-center rounded-[var(--radius-control)] bg-white font-serif text-[22px] font-medium text-[#252525] shadow-[var(--shadow-low)]">
            {name.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13px] leading-5 text-ink">{name}</b>
            <small className="block text-[11px] leading-4 text-muted">{t('product.space')}</small>
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
        <DropdownMenuLabel>{t('knowledge.products')}</DropdownMenuLabel>
        {productChoices(products, current).map((product) => {
          const here = product.here;
          return (
            <DropdownMenuItem key={product.folder} asChild>
              <a
                href={product.href}
                data-testid="product-choice"
                aria-current={here ? 'true' : undefined}
                className="flex items-center gap-2 no-underline"
                onClick={(event) => {
                  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
                  if (here) {
                    event.preventDefault();
                    navigateTo(appPath(WIKI_HOME));
                  }
                }}
              >
                <span className="min-w-0 flex-1 truncate">{product.name}</span>
                {here && <CheckIcon aria-hidden="true" className="size-4 shrink-0" />}
              </a>
            </DropdownMenuItem>
          );
        })}
        {products.length === 0 && <DropdownMenuItem disabled>{name}</DropdownMenuItem>}
      </DropdownMenuContent>
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
      // A sub-area counts every entity of its kinds, as the parent does; a kind with a page of its own is not drawn as a
      // row, but its entities are not lost from the parent's total (the review). Only rows the menu can draw stand open.
      const allSubgroups = childrenOf.map((child): NavSubgroup => ({ group: child.group!, labels: child.labels!, ...(child.short === undefined ? {} : { short: child.short }), total: countedOf(child.group), kinds: shownOf(child.group) }));
      const subgroups = allSubgroups.filter((child) => child.kinds.length > 0);
      const childKindNames = new Set(allSubgroups.flatMap((child) => child.kinds.map((kind) => kind.kind)));
      const direct = shownOf(entry.group).filter((kind) => !childKindNames.has(kind.kind));
      const kinds = entry.group === null ? shownOf(null) : [...direct, ...subgroups.flatMap((child) => child.kinds)];
      return { group: entry.group, labels: entry.labels, ...(entry.short === undefined ? {} : { short: entry.short }), open: entry.open, total: countedOf(entry.group) + allSubgroups.reduce((sum, child) => sum + child.total, 0), kinds, subgroups };
    })
    .filter((entry) => entry.kinds.length > 0);
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
  const link = (active: boolean): string =>
    'nav-link my-px flex items-center gap-2.5 rounded-[var(--radius-row)] px-[10px] py-[9px] text-small no-underline transition-colors duration-150 motion-reduce:transition-none ' +
    (active ? 'nav-current bg-[var(--surface-active)] font-[550] text-ink' : 'text-secondary hover:bg-[var(--surface-hover)] hover:text-ink');
  const waitingLink = (id: string, href: string, Icon: typeof HomeIcon, label: string, count: number, active: boolean): ReactElement => (
    <a
      href={appPath(href)}
      className={link(active) + (count === 0 ? ' text-muted opacity-60' : '')}
      aria-current={active ? 'page' : undefined}
      data-empty={count === 0 ? 'true' : 'false'}
      data-testid={id}
      {...pick(href)}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">{label}</span>
      {/* A count drawn from files is shown only once it is above zero: nothing is read until the fill runs. */}
      {count > 0 && <span className="text-small text-muted" data-testid={`${id}-count`}>{count}</span>}
    </a>
  );
  const directOf = (entry: NavGroup): KindSummary[] => {
    const inSubgroup = new Set(entry.subgroups.flatMap((subgroup) => subgroup.kinds.map((kind) => kind.kind)));
    return entry.kinds.filter((kind) => !inSubgroup.has(kind.kind));
  };
  const kindLink = (kind: KindSummary, padding = '!pl-[30px]'): ReactElement => {
    const active = ownRouteOf(kind, route);
    const address = ownAddressOf(kind);
    return (
      <a key={kind.kind} href={appPath(address)} className={link(active) + ` !py-[7px] ${padding}`} aria-current={active ? 'page' : undefined} data-nav-kind={kind.kind} {...pick(address)}>
        <span className="min-w-0 flex-1 truncate">{kindName(kind.kind, 'many')}</span>
        <span className="text-small text-muted" data-testid="nav-count">
          {kind.count}
          {pendingOf(kind.kind) > 0 && <span className="ml-1" title={t('knowledge.pendingCount', { count: pendingOf(kind.kind) })} data-testid="nav-pending">+{pendingOf(kind.kind)}</span>}
        </span>
      </a>
    );
  };
  return (
    <>
      <a href={appPath(WIKI_HOME)} data-testid="nav-brand" className="nav-brand flex items-center gap-2.5 px-2 py-[14px] text-ink no-underline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2" {...pick(WIKI_HOME)}>
        <BrandMark />
        <strong className="text-[23px] font-[650] leading-none tracking-[-0.8px]">madarch</strong>
        <small className="nav-concept ml-auto rounded-[var(--radius-row)] border border-line px-[5px] py-0.5 text-[11px] leading-4 text-muted">{t('brand.concept')}</small>
      </a>
      <ProductSelector name={status.product.name} products={products} current={folder === '' ? products[0]?.folder ?? null : folder} own={status.own === true} />
      <nav aria-label={t('navigation.pages')} className="min-h-0 flex-1 overflow-y-auto pb-4 pr-2 [scrollbar-gutter:stable]" data-testid="nav-scroll">
        <a href={appPath(WIKI_HOME)} className={link(route.name === 'home')} aria-current={route.name === 'home' ? 'page' : undefined} data-testid="nav-home" {...pick(WIKI_HOME)}>
          <HomeIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.home')}</span>
        </a>
        <a href={appPath(WIKI_CATALOGUE)} className={link(route.name === 'catalogue')} aria-current={route.name === 'catalogue' ? 'page' : undefined} data-testid="nav-catalogue" {...pick(WIKI_CATALOGUE)}>
          <LayoutGridIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('navigation.catalogue')}</span>
        </a>
        <a href={appPath(WIKI_GLOSSARY)} className={link(route.name === 'glossary')} aria-current={route.name === 'glossary' ? 'page' : undefined} data-testid="nav-glossary" {...pick(WIKI_GLOSSARY)}>
          <BookOpenIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.glossary.title')}</span>
        </a>
        <div data-testid="nav-waiting" className="mb-2 mt-2">
          <h2 className="mb-1 px-2 text-[12px] uppercase tracking-[0.08em] text-muted">{t('knowledge.waiting')}</h2>
          {waitingLink('nav-problems', WIKI_PROBLEMS, AlertTriangleIcon, t('loop.problemsTitle'), problemsOpen, route.name === 'problems')}
        </div>
        {groups.length > 0 && <h2 className="mb-1.5 mt-4 px-2 text-[12px] uppercase tracking-[0.08em] text-muted">{t('knowledge.kinds')}</h2>}
        {groups.map((entry) => {
          const key = entry.group ?? '\0other';
          const holdsActive = route.name === 'kind' && entry.kinds.some((kind) => kind.kind === route.kind);
          const open = opened[key] ?? (holdsActive || entry.open);
          return (
            <div key={key} data-nav-group={entry.group ?? ''} className="mb-0.5">
              <button
                type="button"
                className="nav-group flex w-full cursor-pointer items-center gap-1.5 rounded-[var(--radius-row)] px-[6px] py-[7px] text-left text-small font-[550] text-ink hover:bg-[var(--surface-hover)]"
                aria-expanded={open}
                onClick={() => setOpened({ ...opened, [key]: !open })}
                data-testid="nav-group"
              >
                <ChevronRightIcon aria-hidden="true" className={'size-4 shrink-0 text-muted transition-transform motion-reduce:transition-none ' + (open ? 'rotate-90' : '')} />
                <span className="min-w-0 flex-1 truncate">{entry.labels === null ? t('knowledge.groupOther') : entry.short?.[language] ?? entry.labels[language] ?? entry.labels['en'] ?? entry.group}</span>
                <span className="text-small font-normal text-muted" data-testid="nav-group-count">{entry.total}</span>
              </button>
              {open && (
                <>
                  {directOf(entry).map((kind) => kindLink(kind))}
                  {entry.subgroups.map((subgroup) => (
                    <div key={subgroup.group} data-nav-subgroup={subgroup.group} data-testid="nav-subgroup" className="mb-0.5">
                      <div className="flex items-center gap-2 py-[5px] pl-[30px] pr-[10px] text-[11px] uppercase tracking-[0.06em] text-muted">
                        <span className="min-w-0 flex-1 truncate">{subgroup.short?.[language] ?? subgroup.labels[language] ?? subgroup.labels['en'] ?? subgroup.group}</span>
                        <span className="font-normal" data-testid="nav-subgroup-count">{subgroup.total}</span>
                      </div>
                      {subgroup.kinds.map((kind) => kindLink(kind, '!pl-[42px]'))}
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        })}
      </nav>
      <div className="border-t border-line py-2" data-testid="nav-foot">
        <a href={appPath(WIKI_DOCS)} className={link(route.name === 'docs' || route.name === 'doc')} aria-current={route.name === 'docs' || route.name === 'doc' ? 'page' : undefined} data-testid="nav-documents" {...pick(WIKI_DOCS)}>
          <FolderGit2Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.documents')}</span>
        </a>
        {status.own !== true && (
          <a href={appPath(WIKI_SETTINGS)} className={link(route.name === 'settings')} aria-current={route.name === 'settings' ? 'page' : undefined} data-testid="nav-settings" {...pick(WIKI_SETTINGS)}>
            <SettingsIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">{t('settings.nav')}</span>
          </a>
        )}
      </div>
    </>
  );
}

function LanguageMenu(): ReactElement {
  const { t, i18n } = useTranslation();
  const language: WikiLanguage = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" className="shell-language size-9" aria-label={t('navigation.language')} title={t('tooltips.language')}>
          <GlobeIcon aria-hidden="true" className="size-[21px]" />
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={7} className="language-menu">
          <DropdownMenuPrimitive.Label className="language-menu-label">{t('navigation.language')}</DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.Separator className="language-menu-separator" />
          <DropdownMenuPrimitive.RadioGroup value={language} onValueChange={(value: string) => { if (value === 'en' || value === 'ru') void setWikiLanguage(value); }}>
            {(['ru', 'en'] as const).map((code) => (
              <DropdownMenuPrimitive.RadioItem key={code} className="language-menu-item" value={code}>
                <span className="language-menu-check"><DropdownMenuPrimitive.ItemIndicator><CheckIcon aria-hidden="true" className="size-4" /></DropdownMenuPrimitive.ItemIndicator></span>
                {t(code === 'ru' ? 'navigation.russian' : 'navigation.english')}
              </DropdownMenuPrimitive.RadioItem>
            ))}
          </DropdownMenuPrimitive.RadioGroup>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
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
    <div
      // No box of its own: the badge stays the toolbar's flex item it always was, so the one row keeps its width at a
      // phone's width, and the panel is placed against the window rather than against this wrapper.
      className="relative"
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
      <Button
        ref={chip}
        type="button"
        className={`fill-chip rounded-[var(--radius-row)] focus-visible:ring-2 focus-visible:ring-ink${compact ? ' fill-chip-writing' : ''}`}
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
          <span className="fill-chip-label">
            {compact
              ? <><span className="fill-chip-words">{t('knowledge.fillWriting')} · </span><span className="fill-chip-count">{count}</span></>
              : held
                ? <><span className="fill-chip-words">{label}</span><span className="fill-chip-count fill-chip-count-narrow">{count}</span></>
                : narrow === null
                  ? label
                  : <><span className="fill-chip-words">{label}</span><span className="fill-chip-count fill-chip-count-narrow">{narrow}</span></>}
          </span>
        </Badge>
      </Button>
      {open && (
        <Card id="fill-menu-panel" role="dialog" aria-label={t('knowledge.fillMenuTitle')} data-testid="fill-menu" floating>
          <CardContent className="grid gap-2 p-3">
            <KLink href={WIKI_FILL} testId="fill-menu-choose" className="rounded px-2 py-2 text-small text-ink hover:bg-chrome">{t('knowledge.fillChoose')}</KLink>
            {(authoring || filling) && (
              // While the agent writes or the graph is read: the whole sentence and, when there is one, what is being written
              // now, and the way to the fill page (never the paths: the menu is anchored to the top bar and must stay inside
              // a narrow viewport). A fill with no agent still offers the two presses here (madarch-m38l.17).
              <div className="px-2 pb-2 text-small" data-testid="fill-menu-live">
                <p className="m-0 break-words text-ink" data-testid="fill-menu-total">{label}</p>
                {authoring && <p className="m-0 mt-1 break-words" data-testid="fill-menu-current">{currentName === null ? t('knowledge.fillPage.waiting') : t('knowledge.fillPage.writingNow', { name: currentName })}</p>}
                <p className="m-0 mt-1"><KLink href={WIKI_FILL} testId="fill-menu-open">{t('knowledge.fillPage.open')}</KLink></p>
                <RunControls status={status} refresh={refresh} where="menu" />
              </div>
            )}
            {paused && (
              // The run stands where the person left it: what it wrote, the way to its page, and the two presses that take it
              // up again or end it (madarch-m38l.17).
              <div className="px-2 pb-2 text-small" data-testid="fill-menu-paused">
                <p className="m-0 break-words text-ink" data-testid="fill-menu-total">{label}</p>
                <p className="m-0 mt-1"><KLink href={WIKI_FILL} testId="fill-menu-open">{t('knowledge.fillPage.open')}</KLink></p>
                <RunControls status={status} refresh={refresh} where="menu" />
              </div>
            )}
            {!authoring && writer.units.length > 0 && <p className="m-0 px-2 pb-2 text-small" data-testid="fill-menu-open-line"><KLink href={WIKI_FILL} testId="fill-menu-open">{t('knowledge.fillPage.open')}</KLink></p>}
            {writer.asked !== undefined && writer.asked > 0 && <p className="m-0 px-2 pb-2 text-small" data-testid="fill-menu-asked">{t('loop.agentAsked', { count: writer.asked })}</p>}
            {writer.message !== undefined && <div className="m-0 px-2 pb-2 text-small" data-testid="fill-menu-message"><FailureNote scope="writer" code={writer.code ?? (writer.state === 'done' ? 'note' : undefined)} message={writer.message} /></div>}
            {fill.message !== undefined && fill.state === 'failed' && <div className="m-0 px-2 pb-2 text-small"><FailureNote scope="fill" code={fill.code} message={fill.message} /></div>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function Toolbar({ status, route, menu, refresh, products, current }: { status: WikiStatus; route: WikiRoute; menu: ReactNode; refresh: () => void; products: readonly ProductChoice[]; current: string | null }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const where = route.name === 'questions' || route.name === 'question' ? t('loop.questionsTitle') : route.name === 'problems' ? t('loop.problemsTitle') : route.name === 'tasks' ? t('loop.tasksTitle') : route.name === 'settings' ? t('settings.title') : route.name === 'journal' ? t('journal.title') : route.name === 'kind' ? kindName(route.kind, 'many') : route.name === 'source' ? t('knowledge.source') : route.name === 'run' ? t('knowledge.run.title') : route.name === 'docs' || route.name === 'doc' ? t('knowledge.documents') : route.name === 'catalogue' ? t('knowledge.catalogue') : route.name === 'glossary' ? t('knowledge.glossary.title') : route.name === 'statement' ? t('knowledge.statement') : route.name === 'entity' ? null : t('knowledge.home');
  return (
    <header className="shell-toolbar flex min-h-[58px] items-center justify-between gap-3 border-b border-line bg-page px-4 wide:px-[35px]">
      <span className="shell-breadcrumb min-w-0 truncate text-small text-secondary">
        <KLink href={WIKI_HOME} className="text-muted no-underline hover:text-ink">{status.product.name}</KLink>
        {where !== null && <><span aria-hidden="true" className="px-2 text-muted">/</span><span className="text-ink">{where}</span></>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <SearchBox />
        {status.loop !== undefined && status.loop.questionsAnswered > 0 && (
          <KLink href={WIKI_QUESTIONS} className="answers-waiting no-underline" data-testid="answers-waiting" title={t('loop.answersWaitingHint')}>
            <Badge variant="outline"><span className="answers-waiting-words">{t('loop.answersWaiting', { count: status.loop.questionsAnswered })}</span><span className="answers-waiting-count">{status.loop.questionsAnswered}</span></Badge>
          </KLink>
        )}
        {menu}
        {status.own !== true && <FillMenu status={status} refresh={refresh} />}
        <RoleMenu />
        <HelpLink products={products} current={current} />
        <LanguageMenu />
      </span>
    </header>
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
    <span
      className="fill-dot mr-1.5 inline-block size-2 shrink-0 rounded-full align-middle"
      data-testid="fill-dot"
      data-state={state}
      title={words}
      aria-label={words}
      role="img"
    >
      {state === 'up-to-date' && <span aria-hidden="true" className="block size-full rounded-full bg-current" />}
      {state === 'stale' && <span aria-hidden="true" className="block size-full rounded-full border border-current" />}
      {state === 'running' && <span aria-hidden="true" className="block size-full animate-pulse rounded-full bg-current motion-reduce:animate-none" />}
      {state === 'failed' && <span aria-hidden="true" className="block size-full rounded-full border border-current" />}
    </span>
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
    <div role="tablist" aria-label={t('knowledge.tabs')} className="tab-bar flex min-h-[38px] items-end gap-1 overflow-x-auto border-b border-line bg-chrome px-3 pt-1.5 wide:px-[27px]" data-testid="tab-bar">
      {tabs.map((tab) => {
        const here = tab.key === active;
        const title = tab.title ?? t('knowledge.loading');
        return (
          <div
            key={tab.key}
            data-testid="tab"
            data-active={here ? 'true' : 'false'}
            className={'tab group flex min-w-28 items-center rounded-t-md border border-b-0 ' + (here ? 'border-line bg-page text-ink' : 'border-transparent text-secondary hover:bg-chrome')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={here}
              title={title}
              className="min-w-0 flex-1 cursor-pointer truncate bg-transparent px-3 py-1.5 text-left text-small text-inherit focus-visible:ring-2 focus-visible:ring-ink"
              onClick={() => activateTab(tab.key)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.key); } }}
            >
              {title}
            </button>
            {tabs.length > 1 && (
              <button
                type="button"
                aria-label={t('knowledge.closeTab', { title })}
                title={t('knowledge.closeTabShort')}
                data-testid="tab-close"
                className="mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-row)] bg-transparent text-muted hover:bg-[var(--surface-active)] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink"
                onClick={() => closeTab(tab.key)}
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
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
  const { status, error, version, refresh } = useWikiStatus();
  const settings = useSettings();
  const { glossary } = useGlossary(version);
  const glossaryValue = useGlossaryValue(glossary);
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

  if (error !== null && status === null) {
    return <div className="grid min-h-dvh place-items-center bg-page p-6 text-ink [font-family:var(--font-sans)]"><p role="alert" data-testid="wiki-error">{error}</p></div>;
  }
  if (status === null) {
    return (
      <Stack layout="shell" data-testid="wiki-loading">
        <aside className="app-nav hidden w-[240px] wide:w-[260px] shrink-0 flex-col gap-3 border-r border-line bg-chrome px-[14px] py-[18px] wide:px-[18px] md:flex" aria-hidden="true">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-full" />
          {[70, 55, 62, 48].map((width, index) => <Skeleton key={index} className="h-5" style={{ width: `${width}%` }} />)}
        </aside>
        <div className="shell-main flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shell-toolbar min-h-[58px] border-b border-line" />
          <div className="shell-scroll min-h-0 min-w-0 flex-1 overflow-auto" data-testid="shell-content" ref={content}><div className="shell-document w-full"><main><PageSkeleton testId="page-loading" /></main></div></div>
        </div>
      </Stack>
    );
  }
  const currentFolder = decodeURIComponent((/^\/products\/([^/]+)/.exec(window.location.pathname)?.[1] ?? '')) || (products[0]?.folder ?? null);
  const pending = new Set(status.writer.units.filter((unit) => unit.state === 'waiting' || unit.state === 'writing').map((unit) => unit.unit));
  const nav = (onNavigate?: () => void): ReactElement => <NavPanel status={status} products={products} route={route} onNavigate={onNavigate} />;
  const menu = (
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <SheetTrigger asChild>
        <Button className="shell-menu md:!hidden" aria-label={t('navigation.aria')} aria-expanded={menuOpen}>
          <MenuIcon aria-hidden="true" className="size-6 md:size-[22px]" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" title={t('navigation.aria')} closeLabel={t('navigation.close')} data-testid="phone-nav" className="app-nav w-[min(280px,_82vw)] px-[14px] py-3">
        {nav(() => setMenuOpen(false))}
      </SheetContent>
    </Sheet>
  );
  const contentPage = !['catalogue', 'dependencies', 'settings', 'fill', 'run', 'journal'].includes(route.name);
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
  else if (route.name === 'questions') view = <QuestionsPage version={version} />;
  else if (route.name === 'question') view = <QuestionPage key={route.slug} slug={route.slug} version={version} refresh={refresh} />;
  else if (route.name === 'problems') view = <ProblemsPage version={version} refresh={refresh} />;
  else if (route.name === 'settings') view = <SettingsPage version={version} status={status} refresh={refresh} />;
  else if (route.name === 'journal') view = <JournalPage key={`${route.id}\0${route.run ?? ''}`} id={route.id} run={route.run} version={version} />;
  else if (route.name === 'fill') view = <FillPage status={status} refresh={refresh} />;
  else if (route.name === 'tasks') view = <TasksPage version={version} />;
  else if (route.name === 'task') view = <TaskPage key={route.id} id={route.id} version={version} refresh={refresh} />;
  else if (route.name === 'docs') view = <DocumentsPage version={version} />;
  else if (route.name === 'doc') view = <DocumentPage key={`${route.repo ?? ''}:${route.path}`} repo={route.repo} path={route.path} version={version} />;
  else if (route.name === 'catalogue') view = <CataloguePage version={version} />;
  else if (route.name === 'glossary') view = <GlossaryPage version={version} />;
  else if (route.name === 'statement') view = <StatementPage key={`${route.id}\0${route.sentence}\0${route.turn}`} id={route.id} sentence={route.sentence} turn={route.turn} version={version} />;
  else if (route.name === 'run') view = <RunPage key={route.run ?? ''} run={route.run} version={version} />;
  else view = <SourcePage key={`${route.repo ?? ''}:${route.path}`} repo={route.repo} path={route.path} line={route.line} />;
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <KindLabels.Provider value={status.kinds}>
      <RoleContext.Provider value={{ role: settings.role, roles: status.roles ?? {} }}>
      <GlossaryContext.Provider value={glossaryValue}>
      <RoleCard />
      <Stack layout="shell" data-testid="knowledge-app">
        {/* Navigation and page content have separate scroll areas within the viewport. */}
        <aside id="app-nav" className="app-nav hidden w-[240px] wide:w-[260px] shrink-0 border-r border-line bg-chrome md:flex" aria-label={t('navigation.aria')}>
          <Stack layout="navigation">{nav()}</Stack>
        </aside>
        <div className="shell-main flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The top bar and the tab bar stay put; only the page below them scrolls. */}
          <div className="shell-fixed z-30 shrink-0" data-testid="shell-fixed">
            <Toolbar status={status} route={route} menu={menu} refresh={refresh} products={products} current={currentFolder} />
            <TabBar />
          </div>
          <div className="shell-row flex min-h-0 flex-1 overflow-hidden">
            <div className="shell-scroll min-h-0 min-w-0 flex-1 overflow-auto" data-testid="shell-content" ref={content}>
              <div className="shell-document w-full">
                <main data-testid="knowledge-main">
                  {contentPage && status.manifest === 'not-filled' ? <NewHome status={status} refresh={refresh} /> : contentPage && status.manifest === 'no-manifest' ? <EmptyHome status={status} refresh={refresh} /> : (
                    <>
                      {status.own !== true && showsProgress(route, status) && <FillCard status={status} refresh={refresh} />}
                      <PendingPages.Provider value={pending}>{view}</PendingPages.Provider>
                    </>
                  )}
                </main>
              </div>
            </div>
          </div>
        </div>
      </Stack>
      </GlossaryContext.Provider>
      </RoleContext.Provider>
      </KindLabels.Provider>
    </TooltipProvider>
  );
}

