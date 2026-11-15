/**
 * The product's frame (decision 0029, kept by decision 0036, sections 6 and 7): the product's card, the sections every
 * reader opens, the purposes the product gives its kinds and the groups of the kinds the graph holds in the sidebar; the
 * breadcrumb, the search and the reader's own controls in the top bar. Everything it draws comes from the one navigation
 * answer and the app's own words: the sidebar knows no kind of its own, and a row opens the catalogue entry of its kind,
 * whose page the product's templates draw.
 */
import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangleIcon, BookOpenIcon, CheckIcon, CircleHelpIcon, FileTextIcon, FolderGit2Icon, FolderIcon, GlobeIcon,
  HistoryIcon, HomeIcon, LayoutGridIcon, MenuIcon, RefreshCwIcon, SearchIcon, SettingsIcon, UserRoundIcon,
} from 'lucide-react';
import {
  BrandLink, NavigationCount, NavigationFooter, NavigationGroup, NavigationGroupTrigger, NavigationHeading,
  NavigationLabel, NavigationLink, NavigationPending, NavigationScroll, NavigationSection, NavigationSubheading,
  ProductButton,
} from './components/ui/navigation.js';
import {
  ShellActions, ShellBrandMark, ShellIconLink, ShellLanguageButton, ShellMenuButton, ShellNavigationSheet,
  ShellProductLink, ShellProductMenu, ShellRoleButton, ShellRoleLabel, ShellToolbar,
} from './components/ui/shell.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { SearchContainer, SearchResults } from './components/ui/search-results.js';
import { askSearch, GroupsOf, rowsOf, type SearchGroup } from './components/search.js';
import { Sheet, SheetTrigger } from './components/ui/sheet.js';
import { RunIndicator, type LiveRun } from './components/run-indicator.js';
import { FillEntry } from './components/fill-entry.js';
import { PageHeader, PageTitle, Paragraph } from './components/ui/typography.js';
import { CATALOGUE_KIND, EVERYTHING_ROLE } from '../../../src/page-contract/index.js';
import { entityAddress, PAGE_ADDRESSES, RUNS_PAGE, type FramePage, type OpenPage } from './address.js';
import type { ProductChoice } from './components/command.js';
import type { Navigation, NavigationGroup as NavGroup, NavigationKind, NavigationPurpose } from './client.js';

/** The word the frame gives one of its own sections, in the language the reader reads. */
export function frameWord(page: FramePage, t: TFunction): string {
  switch (page) {
    case 'kit': return t('kit.title');
  }
}

/** One group of the sidebar: the kinds it holds by itself, its sub-areas and what the graph holds of them all. */
interface GroupNode {
  readonly group: NavGroup | null;
  readonly kinds: readonly NavigationKind[];
  readonly subgroups: readonly { readonly group: NavGroup; readonly kinds: readonly NavigationKind[] }[];
  readonly total: number;
}

/** One section of the sidebar by the reader's purpose: its word and the kinds the reader's role reads of it. */
interface PurposeNode {
  readonly purpose: NavigationPurpose;
  readonly kinds: readonly NavigationKind[];
}

/** The word a group or a kind is drawn with in the reader's language, else English, else its name. */
function word(labels: Readonly<Record<string, string>> | null, fallback: string, language: string): string {
  return labels?.[language] ?? labels?.['en'] ?? fallback;
}

/** Filled entries first, then the empty ones, each keeping the manifest's order. */
const populatedFirst = <T,>(entries: readonly T[], count: (entry: T) => number): T[] =>
  [...entries.filter((entry) => count(entry) > 0), ...entries.filter((entry) => count(entry) === 0)];

/**
 * The groups of the sidebar: the kinds under the group the product's manifest gave them, the filled entries before the
 * empty ones, the empty ones listed too so the reader sees the product's whole shape. The groups the reader's role leads
 * stand first, in the order the role names them.
 */
export function groupTree(navigation: Navigation, leads: readonly string[] = []): GroupNode[] {
  const known = new Set(navigation.groups.map((group) => group.name));
  const held = navigation.kinds.filter((kind) => kind.nav !== 'loop');
  const of = (name: string | null): NavigationKind[] => held.filter((kind) => (name === null ? kind.group === null || !known.has(kind.group) : kind.group === name));
  const top = navigation.groups.filter((group) => group.parent === null || !known.has(group.parent));
  const nodes: GroupNode[] = top.map((group) => {
    const subgroups = populatedFirst(
      navigation.groups
        .filter((child) => child.parent === group.name)
        .map((child) => ({ group: child, kinds: populatedFirst(of(child.name), (kind) => kind.count) })),
      (child) => child.kinds.reduce((sum, kind) => sum + kind.count, 0),
    );
    const inSubgroup = new Set(subgroups.flatMap((child) => child.kinds.map((kind) => kind.kind)));
    const kinds = populatedFirst(of(group.name), (kind) => kind.count).filter((kind) => !inSubgroup.has(kind.kind));
    const total = [...kinds, ...subgroups.flatMap((child) => child.kinds)].reduce((sum, kind) => sum + kind.count, 0);
    return { group, kinds, subgroups, total };
  });
  const loose = populatedFirst(of(null), (kind) => kind.count);
  if (loose.length > 0) nodes.push({ group: null, kinds: loose, subgroups: [], total: loose.reduce((sum, kind) => sum + kind.count, 0) });
  // Filled groups stand before empty ones, and the role's leading groups before both, in its own order.
  const ordered = populatedFirst(nodes, (node) => node.total);
  if (leads.length === 0) return ordered;
  const first = leads.flatMap((name) => ordered.filter((node) => node.group?.name === name));
  return [...first, ...ordered.filter((node) => !first.includes(node))];
}

/**
 * The sidebar's sections by the reader's purpose (`purposes:` of the manifest): the product's own order, the kinds the
 * reader's role is meant for (`audience:`), the filled kinds only. A product that declares purposes lists its kinds by
 * them instead of by the manifest's groups.
 */
export function purposeTree(navigation: Navigation, role: string): PurposeNode[] {
  const visible = navigation.kinds.filter((kind) => kind.count > 0 && kind.nav !== 'loop'
    && (role === EVERYTHING_ROLE || kind.audience === null || kind.audience.includes(role)));
  return navigation.purposes
    .map((purpose) => ({ purpose, kinds: visible.filter((kind) => kind.purpose === purpose.id) }))
    .filter((node) => node.kinds.length > 0);
}

/**
 * The product's sidebar: its name and the sections every reader opens, the purposes or the groups of the kinds the graph
 * holds, and the footer's two places. Rows of kinds with pages the agent has still to write wear «+N» while a fill runs.
 */
export function FrameNavigation({ navigation, base, path, open, tasks, role, problemsOpen = null, productName = null, products = null, currentProduct = null, pending, leads = [], changed }: {
  readonly navigation: Navigation | null;
  readonly base: string;
  /** The address in front, without the base and the query. */
  readonly path: string;
  readonly open: OpenPage;
  readonly tasks: { readonly home: boolean; readonly frame: FramePage | null };
  /** The role the reader reads as: its purposes, its audience, its leading groups. */
  readonly role: string;
  /** The open problems, for the «Ждёт вас» count; null until the listing is read. */
  readonly problemsOpen?: number | null;
  /** The product's own name from `/api/product`, when the graph holds no product label yet. */
  readonly productName?: string | null;
  /** The products this server serves, for the card at the top left; null until the read answers. */
  readonly products?: readonly ProductChoice[] | null;
  /** The folder this wiki is served under. */
  readonly currentProduct?: string | null;
  /** The pages of each kind a live fill has still to write, for the sidebar's «+N». */
  readonly pending?: Readonly<Record<string, number>>;
  /** The groups the reader's role leads, in the role's own order (the bootstrap's `roleLeads`). */
  readonly leads?: readonly string[];
  /** Kinds a unit publication just changed: their rows wear a short highlight. */
  readonly changed?: ReadonlySet<string>;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const purposes = navigation === null ? [] : purposeTree(navigation, role);
  // A product that declares purposes lists its kinds by them; one that declares none keeps the manifest's groups.
  const grouped = navigation !== null && navigation.purposes.length === 0;
  const nodes = navigation === null || !grouped ? [] : groupTree(navigation, leads);
  const follow = (address: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(address, { newTab: event.ctrlKey || event.metaKey });
  };
  const here = (address: string): boolean => path === address;
  const link = (address: string) => ({ href: base + address, onClick: follow(address), onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => { if (event.button === 1) { event.preventDefault(); open(address, { newTab: true }); } } });
  const kindAddress = (kind: NavigationKind): string => kind.entryId === null ? PAGE_ADDRESSES.catalogue : entityAddress(CATALOGUE_KIND, kind.entryId);
  const left = (kind: NavigationKind): number => pending?.[kind.kind] ?? 0;
  const kindLink = (kind: NavigationKind, depth: 0 | 1 | 2): ReactElement => {
    const address = kindAddress(kind);
    return (
      <NavigationLink icon={FileTextIcon} key={kind.kind} active={here(address)} empty={kind.count === 0} depth={depth} data-testid="nav-kind" data-empty={kind.count === 0 ? 'true' : 'false'} data-changed={changed?.has(kind.kind) ? 'true' : undefined} {...link(address)}>
        <NavigationLabel>{kind.many}</NavigationLabel>
        <NavigationCount data-testid="nav-count">
          {kind.count}
          {left(kind) > 0 ? <NavigationPending title={t('knowledge.pendingCount', { count: left(kind) })} data-testid="nav-pending">{`+${String(left(kind))}`}</NavigationPending> : null}
        </NavigationCount>
      </NavigationLink>
    );
  };
  return (
    <>
      <BrandLink data-testid="nav-brand" concept={t('brand.concept')} {...link('/')}><ShellBrandMark /></BrandLink>
      <ProductCard name={productName ?? navigation?.product ?? t('brand.product')} base={base} products={products} current={currentProduct} />
      <NavigationScroll aria-label={t('navigation.pages')} data-testid="nav-scroll">
        <NavigationLink icon={HomeIcon} active={tasks.home} aria-current={tasks.home ? 'page' : undefined} data-testid="nav-home" {...link('/')}>
          <NavigationLabel>{t('knowledge.home')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink icon={LayoutGridIcon} active={here(PAGE_ADDRESSES.catalogue)} aria-current={here(PAGE_ADDRESSES.catalogue) ? 'page' : undefined} data-testid="nav-catalogue" {...link(PAGE_ADDRESSES.catalogue)}>
          <NavigationLabel>{t('navigation.catalogue')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink icon={BookOpenIcon} active={here(PAGE_ADDRESSES.glossary)} aria-current={here(PAGE_ADDRESSES.glossary) ? 'page' : undefined} data-testid="nav-glossary" {...link(PAGE_ADDRESSES.glossary)}>
          <NavigationLabel>{t('knowledge.glossary.title')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink icon={HistoryIcon} active={here(RUNS_PAGE)} aria-current={here(RUNS_PAGE) ? 'page' : undefined} data-testid="nav-runs" {...link(RUNS_PAGE)}>
          <NavigationLabel>{t('navigation.runs')}</NavigationLabel>
        </NavigationLink>
        <NavigationSection data-testid="nav-waiting">
          <NavigationHeading>{t('knowledge.waiting')}</NavigationHeading>
          <NavigationLink icon={AlertTriangleIcon} active={here(PAGE_ADDRESSES.problems)} aria-current={here(PAGE_ADDRESSES.problems) ? 'page' : undefined} data-testid="nav-problems" {...link(PAGE_ADDRESSES.problems)}>
            <NavigationLabel>{t('loop.problemsTitle')}</NavigationLabel>
            {problemsOpen === null || problemsOpen === 0 ? null : <NavigationCount data-testid="nav-problems-count">{problemsOpen}</NavigationCount>}
          </NavigationLink>
        </NavigationSection>
        {purposes.map((node) => (
          <NavigationSection key={node.purpose.id} data-purpose={node.purpose.id} data-testid="nav-purpose">
            <NavigationHeading>{word(node.purpose.labels, node.purpose.id, language)}</NavigationHeading>
            {node.kinds.map((kind) => kindLink(kind, 0))}
          </NavigationSection>
        ))}
        {grouped && nodes.length > 0 ? <NavigationHeading>{t('knowledge.kinds')}</NavigationHeading> : null}
        {nodes.map((node) => {
          const key = node.group?.name ?? '\u0000other';
          // A group stands open when the reader opened it, when the page in front lies in it, or when the manifest says so.
          const holdsActive = node.kinds.some((kind) => here(kindAddress(kind))) || node.subgroups.some((subgroup) => subgroup.kinds.some((kind) => here(kindAddress(kind))));
          const open = opened[key] ?? (holdsActive || node.group?.open === true);
          return (
            <NavigationGroup key={key} data-nav-group={node.group?.name ?? ''}>
              <NavigationGroupTrigger icon={FolderIcon} open={open} empty={node.total === 0} data-empty={node.total === 0 ? 'true' : 'false'} onClick={() => { setOpened({ ...opened, [key]: !open }); }} data-testid="nav-group">
                <NavigationLabel>{node.group === null ? t('knowledge.groupOther') : word(node.group.short ?? node.group.labels, node.group.name, language)}</NavigationLabel>
                <NavigationCount data-testid="nav-group-count">{node.total}</NavigationCount>
              </NavigationGroupTrigger>
              {open ? (
                <>
                  {node.kinds.map((kind) => kindLink(kind, 1))}
                  {node.subgroups.map((subgroup) => (
                    <NavigationGroup key={subgroup.group.name} data-nav-subgroup={subgroup.group.name} data-testid="nav-subgroup">
                      <NavigationSubheading icon={FolderIcon} empty={subgroup.kinds.every((kind) => kind.count === 0)} data-empty={subgroup.kinds.every((kind) => kind.count === 0) ? 'true' : 'false'}>
                        <NavigationLabel>{word(subgroup.group.short ?? subgroup.group.labels, subgroup.group.name, language)}</NavigationLabel>
                        <NavigationCount data-testid="nav-subgroup-count">{subgroup.kinds.reduce((sum, kind) => sum + kind.count, 0)}</NavigationCount>
                      </NavigationSubheading>
                      {subgroup.kinds.map((kind) => kindLink(kind, 2))}
                    </NavigationGroup>
                  ))}
                </>
              ) : null}
            </NavigationGroup>
          );
        })}
      </NavigationScroll>
      <NavigationFooter data-testid="nav-foot">
        <NavigationLink icon={FolderGit2Icon} active={here(PAGE_ADDRESSES.sources)} aria-current={here(PAGE_ADDRESSES.sources) ? 'page' : undefined} data-testid="nav-sources" {...link(PAGE_ADDRESSES.sources)}>
          <NavigationLabel>{t('navigation.documents')}</NavigationLabel>
        </NavigationLink>
        <NavigationLink icon={SettingsIcon} active={here(PAGE_ADDRESSES.settings)} aria-current={here(PAGE_ADDRESSES.settings) ? 'page' : undefined} data-testid="nav-settings" {...link(PAGE_ADDRESSES.settings)}>
          <NavigationLabel>{t('settings.nav')}</NavigationLabel>
        </NavigationLink>
      </NavigationFooter>
    </>
  );
}

/**
 * The choices the product card offers: each product's name, the address its wiki answers at, and whether it is the one in
 * front. A server that serves one product serves it at its root; a products home serves each wiki under its folder.
 */
export function productChoices(base: string, products: readonly ProductChoice[], current: string | null): { readonly name: string; readonly folder: string; readonly href: string; readonly here: boolean }[] {
  return products.map((product) => ({ name: product.name, folder: product.folder, href: base === '' ? '/' : `/products/${encodeURIComponent(product.folder)}/`, here: product.folder === current }));
}

/**
 * The product at the top left: its name and the space it stands in, and the other products this server serves. A press
 * opens another product's wiki; the one in front wears the check and keeps the reader where they are.
 */
function ProductCard({ name, base, products, current }: { readonly name: string; readonly base: string; readonly products: readonly ProductChoice[] | null; readonly current: string | null }): ReactElement {
  const { t } = useTranslation();
  const choices = products === null ? [] : productChoices(base, products, current);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ProductButton name={name} description={t('product.space')} data-testid="product-selector" aria-label={t('knowledge.chooseProduct')} />
      </DropdownMenuTrigger>
      <ShellProductMenu align="start">
        <DropdownMenuLabel>{t('knowledge.products')}</DropdownMenuLabel>
        {choices.length === 0
          ? <DropdownMenuItem disabled>{name}</DropdownMenuItem>
          : choices.map((product) => (
            <DropdownMenuItem key={product.folder} asChild>
              <ShellProductLink href={product.href} aria-current={product.here ? 'true' : undefined} data-testid="product-choice" onClick={(event) => { if (product.here) event.preventDefault(); }}>
                <NavigationLabel>{product.name}</NavigationLabel>
                {product.here ? <CheckIcon aria-hidden="true" size={16} /> : null}
              </ShellProductLink>
            </DropdownMenuItem>
          ))}
      </ShellProductMenu>
    </DropdownMenu>
  );
}

/** The «?» beside the language globe: madarch's own documentation, from any other product this server serves. */
function HelpLink({ products, current }: { readonly products: readonly ProductChoice[] | null; readonly current: string | null }): ReactElement | null {
  const { t } = useTranslation();
  const own = products?.find((product) => product.own === true);
  if (own === undefined || own.folder === current) return null;
  return (
    <ShellIconLink href={`/products/${encodeURIComponent(own.folder)}/`} aria-label={t('knowledge.help.label')} title={t('knowledge.help.title')} data-testid="help-link">
      <CircleHelpIcon aria-hidden="true" size={21} />
    </ShellIconLink>
  );
}

/** The reader's role: what the page opens and which groups stand first (decision 0031). */
function RoleMenu({ role, roles, onRole }: { readonly role: string; readonly roles: readonly string[]; readonly onRole: (role: string) => void }): ReactElement {
  const { t } = useTranslation();
  const name = (one: string): string => t(`knowledge.roles.names.${one}`, { defaultValue: one });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ShellRoleButton aria-label={t('knowledge.roles.menu')} title={t('knowledge.roles.menuTitle')} data-testid="role-menu">
          <UserRoundIcon aria-hidden="true" size={18} />
          <ShellRoleLabel>{name(role)}</ShellRoleLabel>
        </ShellRoleButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={7}>
        <DropdownMenuLabel>{t('knowledge.roles.menu')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={role} onValueChange={onRole}>
          <DropdownMenuRadioItem value={EVERYTHING_ROLE} data-testid="role-everything">{name(EVERYTHING_ROLE)}</DropdownMenuRadioItem>
          {roles.filter((one) => one !== EVERYTHING_ROLE).map((one) => <DropdownMenuRadioItem key={one} value={one}>{name(one)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The reader's language: one press changes the interface and the page's own words (decision 0031). */
function LanguageMenu({ language, onLanguage }: { readonly language: 'en' | 'ru'; readonly onLanguage: (language: 'en' | 'ru') => void }): ReactElement {
  const { t } = useTranslation();
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
        <DropdownMenuRadioGroup value={language} onValueChange={(value: string) => { if (value === 'en' || value === 'ru') onLanguage(value); }}>
          {(['ru', 'en'] as const).map((code) => (
            <DropdownMenuRadioItem key={code} value={code}>{t(code === 'ru' ? 'navigation.russian' : 'navigation.english')}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The search in the top bar (the old portal's field): as the reader types, the graph's `searchGroups` root answers,
 * grouped by kind in the reader's language with each kind's count; Enter opens the results page, Escape closes them, the
 * arrows walk the rows, and the last row of the answers opens the whole answer. Ctrl+K (Cmd+K on a Mac) puts the field
 * in hand from anywhere, a press anywhere else closes the answers, and at a phone's width the field opens over the bar.
 */
function SearchBox({ base, open }: { readonly base: string; readonly open: OpenPage }): ReactElement {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const [groups, setGroups] = useState<readonly SearchGroup[] | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState(-1);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const box = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (timer.current !== null) clearTimeout(timer.current); }, []);
  // The one shortcut of the bar: Ctrl+K, or Cmd+K on a Mac, puts the field in hand from anywhere on the page.
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setShown(true);
      field.current?.focus();
    };
    window.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('keydown', shortcut); };
  }, []);
  // A press anywhere else closes the answers; the field keeps its words for the next opening.
  useEffect(() => {
    if (!shown) return undefined;
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (target !== null && box.current?.contains(target) === true) return;
      setShown(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => { document.removeEventListener('pointerdown', outside, true); };
  }, [shown]);
  const ask = (value: string): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void askSearch(base, value, undefined, 3, (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en').then((result) => {
        if (!alive.current) return;
        if (result.failure !== undefined) { setFailed(result.failure); setGroups(undefined); setShown(true); return; }
        setFailed(undefined);
        setGroups(result.groups);
        setActive(-1);
        setShown(true);
      });
    }, 180);
  };
  const goResults = (): void => {
    if (text.trim() === '') return;
    setShown(false);
    open(`/p/search?text=${encodeURIComponent(text.trim())}`);
  };
  const words = text.trim();
  return (
    <SearchContainer ref={box} data-open={shown ? 'true' : 'false'} data-testid="search-box">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shell-search-toggle"
        aria-label={t('knowledge.searchLabel')}
        aria-expanded={shown}
        title={t('knowledge.searchHint')}
        data-testid="search-toggle"
        onClick={() => { setShown(!shown); field.current?.focus(); }}
      >
        <SearchIcon aria-hidden="true" size={20} />
      </Button>
      <Input
        ref={field}
        type="search"
        className="shell-search-input"
        value={text}
        aria-label={t('knowledge.searchLabel')}
        placeholder={t('knowledge.searchPlaceholder')}
        title={t('knowledge.searchHint')}
        data-testid="top-search"
        onInput={(event) => { const value = event.currentTarget.value; setText(value); ask(value); }}
        onFocus={() => { if (groups !== undefined || failed !== undefined) setShown(true); }}
        onKeyDown={(event) => {
          const rows = shown && groups !== undefined ? rowsOf(groups, base) : [];
          if (event.key === 'ArrowDown') { event.preventDefault(); if (rows.length > 0) { setActive((held) => (held + 1) % rows.length); setShown(true); } return; }
          if (event.key === 'ArrowUp') { event.preventDefault(); if (rows.length > 0) { setActive((held) => (held <= 0 ? rows.length - 1 : held - 1)); setShown(true); } return; }
          if (event.key === 'Enter') {
            event.preventDefault();
            const chosen = active >= 0 ? rows[active] : undefined;
            if (chosen === undefined) { goResults(); return; }
            setShown(false);
            open(chosen.href);
            return;
          }
          if (event.key === 'Escape') { setShown(false); setActive(-1); }
        }}
      />
      {shown && words !== '' && failed !== undefined
        ? <SearchResults data-testid="search-results"><Paragraph role="alert" data-testid="search-error">{t('knowledge.searchFailed', { message: failed })}</Paragraph></SearchResults>
        : null}
      {shown && words !== '' && failed === undefined && groups !== undefined && groups.length === 0
        ? <SearchResults data-testid="search-results"><Paragraph data-testid="search-empty">{t('knowledge.searchEmpty', { text: words })}</Paragraph></SearchResults>
        : null}
      {shown && failed === undefined && groups !== undefined && groups.length > 0
        ? <GroupsOf groups={groups} base={base} active={active} open={(path) => { setShown(false); open(path); }} resultsHref={words === '' ? undefined : `/p/search?text=${encodeURIComponent(words)}`} />
        : null}
    </SearchContainer>
  );
}

/** The top bar: the search, then the way to the fill, the run, the role, the docs and the language. */
export function FrameToolbar({ base, language, role, roles, busy, menu, open, run, products = null, currentProduct = null, onLanguage, onRole, onReload }: {
  readonly base: string;
  readonly language: 'en' | 'ru';
  readonly role: string;
  readonly roles: readonly string[];
  readonly navigation?: Navigation | null;
  readonly busy: boolean;
  /** The navigation at a phone's width. */
  readonly menu: ReactNode;
  readonly open: OpenPage;
  /** The live fill run, read once by the frame; the indicator draws it. */
  readonly run: LiveRun;
  /** The products this server serves, for the «?» of madarch's own docs. */
  readonly products?: readonly ProductChoice[] | null;
  readonly currentProduct?: string | null;
  readonly onLanguage: (language: 'en' | 'ru') => void;
  readonly onRole: (role: string) => void;
  readonly onReload: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ShellToolbar>
      {menu}
      <SearchBox base={base} open={open} />
      <ShellActions>
        <FillEntry open={open} />
        <RunIndicator live={run.live} run={run.run} open={open} />
        <Button variant="ghost" size="icon" aria-label={t('knowledge.refresh')} title={t('knowledge.refresh')} disabled={busy} onClick={onReload} data-testid="reload">
          <RefreshCwIcon aria-hidden="true" size={18} />
        </Button>
        <RoleMenu role={role} roles={roles} onRole={onRole} />
        <HelpLink products={products} current={currentProduct} />
        <LanguageMenu language={language} onLanguage={onLanguage} />
      </ShellActions>
    </ShellToolbar>
  );
}

/** The navigation at a phone's width: the same sections in a drawer the menu button opens. */
export function PhoneNavigation({ open, onOpenChange, children }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <ShellMenuButton aria-label={t('navigation.menu')} aria-expanded={open} data-testid="phone-menu">
          <MenuIcon aria-hidden="true" size={24} />
        </ShellMenuButton>
      </SheetTrigger>
      <ShellNavigationSheet side="left" title={t('navigation.aria')} closeLabel={t('navigation.close')} data-testid="phone-nav">
        {children}
      </ShellNavigationSheet>
    </Sheet>
  );
}

/** A section of the frame whose page is not rebuilt yet: the frame is back, the page follows in its own step. */
export function RebuildingPage({ word: name }: { readonly word: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <PageHeader>
      <PageTitle data-testid="frame-title">{name}</PageTitle>
      <Paragraph data-testid="frame-rebuilding">{t('knowledge.rebuilding')}</Paragraph>
    </PageHeader>
  );
}
