/**
 * The product's frame (decision 0029, kept by decision 0036, sections 6 and 7): the product's card, the sections every
 * reader opens and the groups of the kinds the graph holds in the sidebar; the breadcrumb and the reader's own controls
 * in the top bar. Everything it draws comes from the one navigation answer and the app's own words: the sidebar knows no
 * kind of its own, and a row opens the catalogue entry of its kind, whose page the product's templates draw.
 */
import { useEffect, useRef, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangleIcon, BookOpenIcon, FileTextIcon, FolderGit2Icon, FolderIcon, GlobeIcon, HistoryIcon, HomeIcon,
  LayoutGridIcon, MenuIcon, RefreshCwIcon, SettingsIcon, UserRoundIcon,
} from 'lucide-react';
import {
  BrandLink, NavigationCount, NavigationFooter, NavigationGroup, NavigationGroupTrigger, NavigationHeading,
  NavigationLabel, NavigationLink, NavigationScroll, NavigationSection, NavigationSubheading, ProductLink,
} from './components/ui/navigation.js';
import {
  ShellActions, ShellBrandMark, ShellLanguageButton, ShellMenuButton, ShellNavigationSheet, ShellRoleButton,
  ShellRoleLabel, ShellToolbar,
} from './components/ui/shell.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { SearchContainer } from './components/ui/search-results.js';
import { askSearch, GroupsOf, rowsOf, type SearchGroup } from './components/search.js';
import { Sheet, SheetTrigger } from './components/ui/sheet.js';
import { RunIndicator } from './components/run-indicator.js';
import { PageHeader, PageTitle, Paragraph } from './components/ui/typography.js';
import { CATALOGUE_KIND } from '../../../src/page-contract/index.js';
import { entityAddress, PAGE_ADDRESSES, RUNS_PAGE, type FramePage } from './address.js';
import type { Navigation, NavigationGroup as NavGroup, NavigationKind } from './client.js';

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

/** The word a group or a kind is drawn with in the reader's language, else English, else its name. */
function word(labels: Readonly<Record<string, string>> | null, fallback: string, language: string): string {
  return labels?.[language] ?? labels?.['en'] ?? fallback;
}

/** The groups of the sidebar: the kinds that hold entities, under the group the product's manifest gave them. */
export function groupTree(navigation: Navigation): GroupNode[] {
  const known = new Set(navigation.groups.map((group) => group.name));
  const held = navigation.kinds.filter((kind) => kind.count > 0 && kind.nav !== 'loop');
  const of = (name: string | null): NavigationKind[] => held.filter((kind) => (name === null ? kind.group === null || !known.has(kind.group) : kind.group === name));
  const top = navigation.groups.filter((group) => group.parent === null || !known.has(group.parent));
  const nodes: GroupNode[] = top.map((group) => {
    const subgroups = navigation.groups
      .filter((child) => child.parent === group.name)
      .map((child) => ({ group: child, kinds: of(child.name) }))
      .filter((child) => child.kinds.length > 0);
    const kinds = of(group.name).filter((kind) => !subgroups.some((child) => child.kinds.some((held) => held.kind === kind.kind)));
    const total = [...kinds, ...subgroups.flatMap((child) => child.kinds)].reduce((sum, kind) => sum + kind.count, 0);
    return { group, kinds, subgroups, total };
  }).filter((node) => node.total > 0);
  const loose = of(null);
  if (loose.length > 0) nodes.push({ group: null, kinds: loose, subgroups: [], total: loose.reduce((sum, kind) => sum + kind.count, 0) });
  // The groups the graph holds entities in stand first, in the manifest's own order within each set.
  return [...nodes.filter((node) => node.total > 0), ...nodes.filter((node) => node.total === 0)];
}

/** The product's name and the sections of the frame, under which the kinds the graph holds are listed. */
export function FrameNavigation({ navigation, base, path, open, tasks, problemsOpen = null, productName = null, changed }: {
  readonly navigation: Navigation | null;
  readonly base: string;
  /** The address in front, without the base and the query. */
  readonly path: string;
  readonly open: (path: string) => void;
  readonly tasks: { readonly home: boolean; readonly frame: FramePage | null };
  /** The open problems, for the «Ждёт вас» count; null until the listing is read. */
  readonly problemsOpen?: number | null;
  /** The product's own name from `/api/product`, when the graph holds no product label yet. */
  readonly productName?: string | null;
  /** Kinds a unit publication just changed: their rows wear a short highlight. */
  readonly changed?: ReadonlySet<string>;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const nodes = navigation === null ? [] : groupTree(navigation);
  const follow = (address: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(address);
  };
  const here = (address: string): boolean => path === address;
  const link = (address: string) => ({ href: base + address, onClick: follow(address) });
  const kindAddress = (kind: NavigationKind): string => kind.entryId === null ? PAGE_ADDRESSES.catalogue : entityAddress(CATALOGUE_KIND, kind.entryId);
  const kindLink = (kind: NavigationKind, depth: 1 | 2): ReactElement => {
    const address = kindAddress(kind);
    return (
      <NavigationLink icon={FileTextIcon} key={kind.kind} active={here(address)} depth={depth} data-testid="nav-kind" data-changed={changed?.has(kind.kind) ? 'true' : undefined} {...link(address)}>
        <NavigationLabel>{kind.many}</NavigationLabel>
        <NavigationCount data-testid="nav-count">{kind.count}</NavigationCount>
      </NavigationLink>
    );
  };
  return (
    <>
      <BrandLink data-testid="nav-brand" concept={t('brand.concept')} {...link('/')}><ShellBrandMark /></BrandLink>
      <ProductCard name={productName ?? navigation?.product ?? t('brand.product')} href={base + '/'} onClick={follow('/')} />
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
        {nodes.length === 0 ? null : <NavigationHeading>{t('knowledge.kinds')}</NavigationHeading>}
        {nodes.map((node) => {
          const key = node.group?.name ?? '\u0000other';
          // A group the graph holds entities in stands open until the reader closes it: its kinds and their counts are what
          // the sidebar is for, and the list only holds groups that hold entities.
          const open = opened[key] ?? true;
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
                      <NavigationSubheading icon={FolderIcon} empty={false} data-empty="false">
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
 * The product at the top left: its name and the space it stands in. The wiki is served for one product's graph, so the
 * menu names that product and nothing else; a server that serves a products home opens each wiki under its own address.
 */
function ProductCard({ name, href, onClick }: { readonly name: string; readonly href: string; readonly onClick?: AnchorHTMLAttributes<HTMLAnchorElement>['onClick'] }): ReactElement {
  const { t } = useTranslation();
  return <ProductLink name={name} description={t('product.space')} href={href} onClick={onClick} data-testid="product-selector" aria-label={t('knowledge.home')} />;
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
          <ShellRoleLabel>{role === 'everything' ? name('everything') : name(role)}</ShellRoleLabel>
        </ShellRoleButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={7}>
        <DropdownMenuLabel>{t('knowledge.roles.menu')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={role} onValueChange={onRole}>
          <DropdownMenuRadioItem value="all">{name('everything')}</DropdownMenuRadioItem>
          {roles.map((one) => <DropdownMenuRadioItem key={one} value={one}>{name(one)}</DropdownMenuRadioItem>)}
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
 * grouped by kind in the reader's language with each kind's count; Enter opens the results page, Escape closes them, and
 * the last row of the answers opens the whole answer.
 */
function SearchBox({ base, open }: { readonly base: string; readonly open: (path: string) => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const [groups, setGroups] = useState<readonly SearchGroup[] | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState(-1);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (timer.current !== null) clearTimeout(timer.current); }, []);
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
  return (
    <SearchContainer>
      <Input
        className="shell-search-input"
        value={text}
        aria-label={t('knowledge.searchLabel')}
        placeholder={t('knowledge.searchPlaceholder')}
        data-testid="top-search"
        onChange={(event) => { setText(event.target.value); ask(event.target.value); }}
        onFocus={() => { if (groups !== undefined) setShown(true); }}
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
      {shown && failed === undefined && groups !== undefined && groups.length > 0
        ? <GroupsOf groups={groups} base={base} active={active} open={(path) => { setShown(false); open(path); }} resultsHref={text.trim() === '' ? undefined : `/p/search?text=${encodeURIComponent(text.trim())}`} />
        : null}
    </SearchContainer>
  );
}

/** The top bar: the search, then the way to the fill, the role and the language. The page's trail stands in the content. */
export function FrameToolbar({ base, language, role, roles, busy, menu, open, onLanguage, onRole, onReload }: {
  readonly base: string;
  readonly language: 'en' | 'ru';
  readonly role: string;
  readonly roles: readonly string[];
  readonly navigation?: Navigation | null;
  readonly busy: boolean;
  /** The navigation at a phone's width. */
  readonly menu: ReactNode;
  readonly open: (path: string) => void;
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
        <RunIndicator base={base} open={open} />
        <Button variant="ghost" size="icon" aria-label={t('knowledge.refresh')} title={t('knowledge.refresh')} disabled={busy} onClick={onReload} data-testid="reload">
          <RefreshCwIcon aria-hidden="true" size={18} />
        </Button>
        <RoleMenu role={role} roles={roles} onRole={onRole} />
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
