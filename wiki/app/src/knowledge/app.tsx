/**
 * The knowledge wiki (decision 0029): the product chosen at the top left, the
 * kinds the product's manifest declares, and the page of one entity at a time
 * drawn from the server's page model. The app holds no kind, no template and no
 * page of its own: an empty product says what to do, and a fill that runs while
 * the page is open is read again as each commit lands.
 */
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { AlertTriangleIcon, BookOpenIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderGit2Icon, GlobeIcon, HelpCircleIcon, HomeIcon, LayoutGridIcon, MenuIcon, SettingsIcon, XIcon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { setWikiLanguage, type WikiLanguage } from '../i18n.js';
import { navigateTo } from '../hold.js';
import { activateTab, closeTab, linkHandlers, useTabs } from './tabs.js';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { getProducts, startFill } from './api.js';
import { KLink } from './blocks.js';
import { CataloguePage, DocumentPage, DocumentsPage, EntityPage, EmptyHome, FillCard, KindPage, SourcePage, StatementPage, Overview } from './pages.js';
import { GlossaryContext, GlossaryPage, useGlossary, useGlossaryValue, useTerms } from './glossary.js';
import { HelpLink, RoleCard, RoleMenu } from './role-ui.js';
import { RoleContext, leadGroups, loadSettings, useRole, useSettings } from './roles.js';
import { addressOfKind, K_CATALOGUE, K_DOCS, K_GLOSSARY, K_HOME, K_PROBLEMS, K_QUESTIONS, K_TASKS, K_SETTINGS, kRouteOf, type KRoute } from './routes.js';
import { ProblemsPage, QuestionPage, QuestionsPage, TaskPage, TasksPage, RefreshPreviewView } from './loop.js';
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
import { UNIT_STATE_KEY } from './writer.js';

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
export function showsProgress(route: KRoute, status: WikiStatus): boolean {
  if (route.name === 'home') return status.home !== null;
  return route.name === 'entity';
}

/** The two kinds of the loop have their own places («Вопросы», «Проблемы»), not a kind page of their own. */
const LOOP_KINDS: ReadonlySet<string> = new Set(['question', 'correction']);

/** The choices the selector offers: each product's wiki address, and which one is open. */
export function productChoices(products: readonly ProductChoice[], current: string | null): { name: string; folder: string; href: string; here: boolean }[] {
  return products.map((product) => ({ name: product.name, folder: product.folder, href: `/products/${encodeURIComponent(product.folder)}${K_HOME}`, here: product.folder === current }));
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
                    navigateTo(appPath(K_HOME));
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

/** The kinds that have a top-level page of their own in the navigation (the glossary is the page of the glossary terms): "Pages by kind" does not list them again. Their pages stay reachable from that page and from links. */
const KINDS_WITH_OWN_PAGE: ReadonlySet<string> = new Set(['doc.term', 'task']);

/** The kinds of the manifest as the navigation shows them: by group, in the manifest's order, the groups with the entities they hold. */
export function navGroups(status: WikiStatus, pending: (kind: string) => number): { group: string | null; labels: Record<string, string> | null; total: number; kinds: KindSummary[] }[] {
  // A group counts every entity of its kinds, the home page included, so the navigation and the catalogue say the same number.
  const counted = status.kinds.filter((kind) => !LOOP_KINDS.has(kind.kind));
  const shown = status.kinds.filter((kind) => !LOOP_KINDS.has(kind.kind) && !KINDS_WITH_OWN_PAGE.has(kind.kind) && !kind.single && (kind.count > 0 || pending(kind.kind) > 0));
  const declared = status.groups.map((group) => ({ group: group.group as string | null, labels: group.labels as Record<string, string> | null }));
  const known = new Set(status.groups.map((group) => group.group));
  const loose = shown.filter((kind) => kind.group === undefined || !known.has(kind.group));
  const all = loose.length > 0 ? [...declared, { group: null, labels: null }] : declared;
  return all
    .map((entry) => {
      const belongs = (kind: KindSummary): boolean => (entry.group === null ? kind.group === undefined || !known.has(kind.group) : kind.group === entry.group);
      const kinds = shown.filter(belongs);
      return { ...entry, kinds, total: counted.filter(belongs).reduce((sum, kind) => sum + kind.count, 0) };
    })
    .filter((entry) => entry.kinds.length > 0);
}

function NavPanel({ status, products, route, onNavigate }: { status: WikiStatus; products: readonly ProductChoice[]; route: KRoute; onNavigate?: () => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const kindName = useKindName();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const folder = decodeURIComponent((/^\/products\/([^/]+)/.exec(window.location.pathname)?.[1] ?? ''));
  const questionsOpen = status.loop?.questionsOpen ?? 0;
  /** The pages of a kind the agent has yet to write: its units that wait or are writing (a unit is named `<kind>:<slug>`). */
  const pendingOf = (kind: string): number => status.writer.units.filter((unit) => unit.unit.startsWith(`${kind}:`) && (unit.state === 'waiting' || unit.state === 'writing')).length;
  const { role, roles } = useRole();
  const { terms } = useTerms();
  const groups = leadGroups(navGroups(status, pendingOf), role, roles);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const pick = (address: string) => linkHandlers(address, onNavigate);
  const link = (active: boolean): string =>
    'nav-link my-px flex items-center gap-2.5 rounded-[var(--radius-row)] px-[10px] py-[9px] text-small no-underline transition-colors duration-150 motion-reduce:transition-none ' +
    (active ? 'nav-current bg-[var(--surface-active)] font-[550] text-ink' : 'text-secondary hover:bg-[var(--surface-hover)] hover:text-ink');
  return (
    <>
      <a href={appPath(K_HOME)} data-testid="nav-brand" className="nav-brand flex items-center gap-2.5 px-2 py-[14px] text-ink no-underline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2" {...pick(K_HOME)}>
        <BrandMark />
        <strong className="text-[23px] font-[650] leading-none tracking-[-0.8px]">madarch</strong>
        <small className="nav-concept ml-auto rounded-[var(--radius-row)] border border-line px-[5px] py-0.5 text-[11px] leading-4 text-muted">{t('brand.concept')}</small>
      </a>
      <ProductSelector name={status.product.name} products={products} current={folder === '' ? products[0]?.folder ?? null : folder} own={status.own === true} />
      <nav aria-label={t('navigation.pages')} className="min-h-0 flex-1 overflow-y-auto pb-4 pr-2 [scrollbar-gutter:stable]" data-testid="nav-scroll">
        <a href={appPath(K_HOME)} className={link(route.name === 'home')} aria-current={route.name === 'home' ? 'page' : undefined} data-testid="nav-home" {...pick(K_HOME)}>
          <HomeIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.home')}</span>
        </a>
        <a href={appPath(K_CATALOGUE)} className={link(route.name === 'catalogue')} aria-current={route.name === 'catalogue' ? 'page' : undefined} data-testid="nav-catalogue" {...pick(K_CATALOGUE)}>
          <LayoutGridIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.catalogue')}</span>
        </a>
        {terms.length > 0 && (
          <a href={appPath(K_GLOSSARY)} className={link(route.name === 'glossary')} aria-current={route.name === 'glossary' ? 'page' : undefined} data-testid="nav-glossary" {...pick(K_GLOSSARY)}>
            <BookOpenIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">{t('knowledge.glossary.title')}</span>
            <span className="text-small text-muted">{terms.length}</span>
          </a>
        )}
        {groups.length > 0 && <h2 className="mb-1.5 mt-4 px-2 text-[12px] uppercase tracking-[0.08em] text-muted">{t('knowledge.kinds')}</h2>}
        {groups.map((entry) => {
          const key = entry.group ?? '\0other';
          const holdsActive = route.name === 'kind' && entry.kinds.some((kind) => kind.kind === route.kind);
          const open = opened[key] ?? (holdsActive || entry.group === 'product');
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
                <span className="min-w-0 flex-1 truncate">{entry.labels === null ? t('knowledge.groupOther') : entry.labels[language] ?? entry.labels['en'] ?? entry.group}</span>
                <span className="text-small font-normal text-muted" data-testid="nav-group-count">{entry.total}</span>
              </button>
              {open && entry.kinds.map((kind) => {
                const active = route.name === 'kind' && route.kind === kind.kind;
                return (
                  <a key={kind.kind} href={appPath(addressOfKind(kind.kind))} className={link(active) + ' !py-[7px] !pl-[30px]'} aria-current={active ? 'page' : undefined} data-nav-kind={kind.kind} {...pick(addressOfKind(kind.kind))}>
                    <span className="min-w-0 flex-1 truncate">{kindName(kind.kind, 'many')}</span>
                    <span className="text-small text-muted" data-testid="nav-count">
                      {kind.count}
                      {pendingOf(kind.kind) > 0 && <span className="ml-1" title={t('knowledge.pendingCount', { count: pendingOf(kind.kind) })} data-testid="nav-pending">+{pendingOf(kind.kind)}</span>}
                    </span>
                  </a>
                );
              })}
            </div>
          );
        })}
        <a href={appPath(K_QUESTIONS)} className={link(route.name === 'questions' || route.name === 'question') + ' mt-4'} aria-current={route.name === 'questions' || route.name === 'question' ? 'page' : undefined} data-testid="nav-questions" {...pick(K_QUESTIONS)}>
          <HelpCircleIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('loop.questionsTitle')}</span>
          {questionsOpen > 0 && <span className="text-small text-muted" data-testid="nav-questions-count">{questionsOpen}</span>}
        </a>
        <a href={appPath(K_TASKS)} className={link(route.name === 'tasks' || route.name === 'task')} aria-current={route.name === 'tasks' ? 'page' : undefined} data-testid="nav-tasks" {...pick(K_TASKS)}>
          <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('loop.tasksTitle')}</span>
        </a>
        <a href={appPath(K_PROBLEMS)} className={link(route.name === 'problems')} aria-current={route.name === 'problems' ? 'page' : undefined} data-testid="nav-problems" {...pick(K_PROBLEMS)}>
          <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('loop.problemsTitle')}</span>
          {(status.problemsOpen ?? 0) > 0 && <span className="text-small text-muted" data-testid="nav-problems-count">{status.problemsOpen ?? 0}</span>}
        </a>
        <a href={appPath(K_DOCS)} className={link(route.name === 'docs' || route.name === 'doc')} aria-current={route.name === 'docs' || route.name === 'doc' ? 'page' : undefined} data-testid="nav-documents" {...pick(K_DOCS)}>
          <FolderGit2Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.documents')}</span>
        </a>
      </nav>
      {status.own !== true && (
        <div className="border-t border-line py-2">
          <a href={appPath(K_SETTINGS)} className={link(route.name === 'settings')} aria-current={route.name === 'settings' ? 'page' : undefined} data-testid="nav-settings" {...pick(K_SETTINGS)}>
            <SettingsIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">{t('settings.nav')}</span>
          </a>
        </div>
      )}
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
  return status.kinds.filter((kind) => kind.source === 'markdown' && !LOOP_KINDS.has(kind.kind)).reduce((sum, kind) => sum + kind.count, 0);
}

/**
 * The fill's state in the toolbar: while it runs, how far it is; after it, a quiet line saying when it ended and how many
 * pages the wiki holds. Opening it shows the units of the last run and the one action to refresh (madarch-m38l.4): the
 * code is read again from the new commits and the pages' links are checked again; the agent writes only the pages
 * that do not exist yet, or all of them when the language of the pages was changed.
 */
export function FillMenu({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [pagesLanguage, setPagesLanguage] = useState<string | null>(null);
  const fill = status.fill;
  const writer = status.writer;
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const pages = pagesOf(status);
  if (status.manifest !== 'ok') return null;
  let label: string;
  let solid = false;
  if (fill.state === 'running') { label = fillWords(fill, t); solid = true; }
  else if (fill.state === 'failed') label = t('knowledge.fillFailed');
  else if (writer.state === 'running' || writer.state === 'waiting') { label = t('knowledge.fillWriting'); solid = true; }
  else if (status.filled) {
    const when = fill.finishedAt === undefined ? null : new Date(fill.finishedAt).toLocaleDateString(language, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    label = when === null ? t('knowledge.fillDoneNoDate', { count: pages }) : t('knowledge.fillDone', { date: when, count: pages });
  } else return null;
  const busy = fill.state === 'running' || writer.state === 'running' || writer.state === 'waiting' || starting;
  const press = (): void => {
    setStarting(true);
    setRefused(null);
    const chosenLanguage = pagesLanguage ?? status.language;
    startFill(status.chosenAgent?.id ?? null, chosenLanguage !== status.language ? chosenLanguage : undefined).then(
      () => { setStarting(false); refresh(); },
      (failure: unknown) => { setStarting(false); setRefused(failure instanceof Error ? failure.message : String(failure)); },
    );
  };
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button type="button" className="fill-chip rounded-[var(--radius-row)] focus-visible:ring-2 focus-visible:ring-ink" data-testid="fill-chip" title={t('knowledge.fillMenuTitle')}>
          <Badge variant={solid ? 'solid' : 'outline'}>{label}</Badge>
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={7} className="language-menu fill-menu w-[min(26rem,92vw)]" data-testid="fill-menu">
          <DropdownMenuPrimitive.Label className="language-menu-label">{t('knowledge.fillMenuTitle')}</DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.Separator className="language-menu-separator" />
          {writer.units.length > 0 && (
            <ul className="m-0 list-none px-2 pb-2 text-small" data-testid="fill-menu-units">
              {writer.units.map((unit) => (
                <li key={unit.unit} className="flex items-center justify-between gap-3 py-0.5"><code>{unit.path}</code><span className="text-muted">{t(UNIT_STATE_KEY[unit.state])}</span></li>
              ))}
            </ul>
          )}
          {writer.asked !== undefined && writer.asked > 0 && <p className="m-0 px-2 pb-2 text-small" data-testid="fill-menu-asked">{t('loop.agentAsked', { count: writer.asked })}</p>}
          {writer.message !== undefined && <div className="m-0 px-2 pb-2 text-small" data-testid="fill-menu-message"><FailureNote scope="writer" code={writer.code ?? (writer.state === 'done' ? 'note' : undefined)} message={writer.message} /></div>}
          {fill.message !== undefined && fill.state === 'failed' && <div className="m-0 px-2 pb-2 text-small"><FailureNote scope="fill" code={fill.code} message={fill.message} /></div>}
          <div className="px-2 pb-2">
            {status.chosenAgent !== null && (
              <div className="mb-3" role="radiogroup" aria-label={t('knowledge.writer.languageTitle')} data-testid="menu-language">
                <div className="mb-1 text-small font-medium text-ink">{t('knowledge.writer.languageTitle')}</div>
                <div className="flex flex-wrap gap-2">
                  {(['ru', 'en'] as const).map((code) => (
                    <label key={code} className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-card)] border border-line px-2.5 py-1 text-small has-[:checked]:border-ink">
                      <input type="radio" name="menu-content-language" checked={(pagesLanguage ?? status.language) === code} onChange={() => setPagesLanguage(code)} onClick={(event) => event.stopPropagation()} />
                      <span>{t(code === 'ru' ? 'navigation.russian' : 'navigation.english')}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {writer.state !== 'running' && writer.state !== 'waiting' && fill.state !== 'running' && <div className="mb-3"><RefreshPreviewView language={pagesLanguage ?? status.language} refreshKey={`${status.fill.finishedAt ?? ''}:${status.writer.finishedAt ?? ''}:${status.loop?.questionsAnswered ?? 0}:${status.loop?.correctionsOpen ?? 0}`} /></div>}
            <p className="mb-2 mt-0 text-small text-muted" data-testid="refresh-note">{t('knowledge.refreshNote', { turns: status.bounds.turns, minutes: status.bounds.minutes })}</p>
            <Button variant="default" size="default" disabled={busy} onClick={press} data-testid="refresh">{t('knowledge.refresh')}</Button>
            {refused !== null && <p className="mb-0 mt-2 text-small" role="alert" data-testid="refresh-refused">{refused}</p>}
          </div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function Toolbar({ status, route, menu, refresh, products, current }: { status: WikiStatus; route: KRoute; menu: ReactNode; refresh: () => void; products: readonly ProductChoice[]; current: string | null }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const where = route.name === 'questions' || route.name === 'question' ? t('loop.questionsTitle') : route.name === 'problems' ? t('loop.problemsTitle') : route.name === 'tasks' ? t('loop.tasksTitle') : route.name === 'settings' ? t('settings.title') : route.name === 'journal' ? t('journal.title') : route.name === 'kind' ? kindName(route.kind, 'many') : route.name === 'source' ? t('knowledge.source') : route.name === 'docs' || route.name === 'doc' ? t('knowledge.documents') : route.name === 'catalogue' ? t('knowledge.catalogue') : route.name === 'glossary' ? t('knowledge.glossary.title') : route.name === 'statement' ? t('knowledge.statement') : route.name === 'entity' ? null : t('knowledge.home');
  return (
    <header className="shell-toolbar flex min-h-[58px] items-center justify-between gap-3 border-b border-line bg-page px-4 wide:px-[35px]">
      <span className="shell-breadcrumb min-w-0 truncate text-small text-secondary">
        <KLink href={K_HOME} className="text-muted no-underline hover:text-ink">{status.product.name}</KLink>
        {where !== null && <><span aria-hidden="true" className="px-2 text-muted">/</span><span className="text-ink">{where}</span></>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {status.loop !== undefined && status.loop.questionsAnswered > 0 && (
          <KLink href={K_QUESTIONS} className="answers-waiting no-underline" data-testid="answers-waiting" title={t('loop.answersWaitingHint')}>
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

/** The route an in-wiki address is; the home page for one the wiki does not know. */
export function routeOfAddress(address: string): KRoute {
  const url = new URL(address, 'http://wiki.invalid');
  return kRouteOf(url.pathname, url.search) ?? { name: 'home' };
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
            className={'tab group flex max-w-[16rem] min-w-[7rem] items-center rounded-t-[var(--radius-row)] border border-b-0 ' + (here ? 'border-line bg-page text-ink' : 'border-transparent text-secondary hover:bg-[var(--surface-hover)]')}
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
  const frontAddress = tabs.tabs.find((tab) => tab.key === tabs.active)?.address ?? K_HOME;
  const route = useMemo<KRoute>(() => routeOfAddress(frontAddress), [frontAddress]);
  const [products, setProducts] = useState<ProductChoice[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
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
    if (route.name !== 'source' && route.name !== 'doc') window.scrollTo?.(0, 0);
  }, [route]);

  if (error !== null && status === null) {
    return <div className="grid min-h-dvh place-items-center bg-page p-6 text-ink [font-family:var(--font-sans)]"><p role="alert" data-testid="wiki-error">{error}</p></div>;
  }
  if (status === null) {
    return (
      <div className="shell flex min-h-dvh bg-page text-ink [font-family:var(--font-sans)] text-body" data-testid="wiki-loading">
        <aside className="app-nav hidden w-[240px] wide:w-[260px] shrink-0 flex-col gap-3 border-r border-line bg-chrome px-[14px] py-[18px] wide:px-[18px] md:flex" aria-hidden="true">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-full" />
          {[70, 55, 62, 48].map((width, index) => <Skeleton key={index} className="h-5" style={{ width: `${width}%` }} />)}
        </aside>
        <div className="shell-main flex min-w-0 flex-1 flex-col">
          <header className="shell-toolbar min-h-[58px] border-b border-line" />
          <div className="shell-scroll min-w-0 flex-1"><div className="shell-document w-full"><main><PageSkeleton testId="page-loading" /></main></div></div>
        </div>
      </div>
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
  let view: ReactElement;
  if (route.name === 'home') view = status.home !== null ? <EntityPage key={status.home} id={status.home} version={version} /> : <Overview status={status} refresh={refresh} />;
  else if (route.name === 'entity') view = <EntityPage key={route.id} id={route.id} version={version} />;
  else if (route.name === 'kind') view = <KindPage key={route.kind} kind={route.kind} version={version} />;
  else if (route.name === 'questions') view = <QuestionsPage version={version} />;
  else if (route.name === 'question') view = <QuestionPage key={route.slug} slug={route.slug} version={version} refresh={refresh} />;
  else if (route.name === 'problems') view = <ProblemsPage version={version} refresh={refresh} />;
  else if (route.name === 'settings') view = <SettingsPage version={version} status={status} refresh={refresh} />;
  else if (route.name === 'journal') view = <JournalPage key={`${route.id}\0${route.run ?? ''}`} id={route.id} run={route.run} version={version} />;
  else if (route.name === 'tasks') view = <TasksPage version={version} />;
  else if (route.name === 'task') view = <TaskPage key={route.id} id={route.id} version={version} refresh={refresh} />;
  else if (route.name === 'docs') view = <DocumentsPage version={version} />;
  else if (route.name === 'doc') view = <DocumentPage key={`${route.repo ?? ''}:${route.path}`} repo={route.repo} path={route.path} version={version} />;
  else if (route.name === 'catalogue') view = <CataloguePage status={status} />;
  else if (route.name === 'glossary') view = <GlossaryPage version={version} />;
  else if (route.name === 'statement') view = <StatementPage key={`${route.id}\0${route.sentence}\0${route.turn}`} id={route.id} sentence={route.sentence} turn={route.turn} version={version} />;
  else view = <SourcePage key={`${route.repo ?? ''}:${route.path}`} repo={route.repo} path={route.path} line={route.line} />;
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <KindLabels.Provider value={status.kinds}>
      <RoleContext.Provider value={{ role: settings.role, roles: status.roles ?? {} }}>
      <GlossaryContext.Provider value={glossaryValue}>
      <RoleCard />
      <div className="shell flex min-h-dvh bg-page text-ink [font-family:var(--font-sans)] text-body" data-testid="knowledge-app">
        <aside id="app-nav" className="app-nav sticky top-0 hidden h-dvh w-[240px] wide:w-[260px] shrink-0 flex-col border-r border-line bg-chrome px-[14px] wide:px-[18px] md:flex" aria-label={t('navigation.aria')}>
          {nav()}
        </aside>
        <div className="shell-main flex min-w-0 flex-1 flex-col">
          {/* The top bar and the tab bar stay put; only the page below them scrolls. */}
          <div className="shell-fixed sticky top-0 z-30" data-testid="shell-fixed">
            <Toolbar status={status} route={route} menu={menu} refresh={refresh} products={products} current={currentFolder} />
            <TabBar />
          </div>
          <div className="shell-row flex flex-1">
            <div className="shell-scroll min-w-0 flex-1">
              <div className="shell-document w-full">
                <main data-testid="knowledge-main">
                  {status.manifest === 'no-manifest' ? <EmptyHome status={status} refresh={refresh} /> : (
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
      </div>
      </GlossaryContext.Provider>
      </RoleContext.Provider>
      </KindLabels.Provider>
    </TooltipProvider>
  );
}

