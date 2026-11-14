/**
 * The product's frame (decision 0029, kept by decision 0036, sections 6 and 7): the product's card, the sections every
 * reader opens and the groups of the kinds the graph holds in the sidebar; the breadcrumb and the reader's own controls
 * in the top bar. Everything it draws comes from the one navigation answer and the app's own words: the sidebar knows no
 * kind of its own, and a row opens the catalogue entry of its kind, whose page the product's templates draw.
 */
import { useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangleIcon, BookOpenIcon, CheckIcon, FileTextIcon, FolderGit2Icon, FolderIcon, GlobeIcon, HomeIcon,
  LayoutGridIcon, MenuIcon, RefreshCwIcon, SettingsIcon, UserRoundIcon,
} from 'lucide-react';
import {
  BrandLink, NavigationCount, NavigationFooter, NavigationGroup, NavigationGroupTrigger, NavigationHeading,
  NavigationLabel, NavigationLink, NavigationScroll, NavigationSection, NavigationSubheading, ProductButton,
} from './components/ui/navigation.js';
import {
  ShellActions, ShellBreadcrumb, ShellBreadcrumbSeparator, ShellBrandMark, ShellHomeLink, ShellLanguageButton,
  ShellMenuButton, ShellNavigationSheet, ShellProductLink, ShellProductMenu, ShellRoleButton, ShellRoleLabel, ShellToolbar,
} from './components/ui/shell.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import { Button } from './components/ui/button.js';
import { Sheet, SheetTrigger } from './components/ui/sheet.js';
import { PageHeader, PageTitle, Paragraph, Text } from './components/ui/typography.js';
import { CATALOGUE_KIND } from '../../../src/page-contract/index.js';
import { entityAddress, FRAME_PAGES, type FramePage } from './address.js';
import type { Navigation, NavigationGroup as NavGroup, NavigationKind } from './client.js';

/** The word the frame gives one of its own sections, in the language the reader reads. */
export function frameWord(page: FramePage, t: TFunction): string {
  switch (page) {
    case 'catalogue': return t('navigation.catalogue');
    case 'glossary': return t('knowledge.glossary.title');
    case 'fill': return t('navigation.fill');
    case 'problems': return t('loop.problemsTitle');
    case 'documents': return t('navigation.documents');
    case 'settings': return t('settings.nav');
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
  const held = navigation.kinds.filter((kind) => kind.count > 0);
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
export function FrameNavigation({ navigation, base, path, open, tasks }: {
  readonly navigation: Navigation | null;
  readonly base: string;
  /** The address in front, without the base and the query. */
  readonly path: string;
  readonly open: (path: string) => void;
  readonly tasks: { readonly home: boolean; readonly frame: FramePage | null };
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
  const section = (id: FramePage, icon: typeof HomeIcon): ReactElement => (
    <NavigationLink icon={icon} active={here(FRAME_PAGES[id])} aria-current={here(FRAME_PAGES[id]) ? 'page' : undefined} data-testid={`nav-${id}`} {...link(FRAME_PAGES[id])}>
      <NavigationLabel>{frameWord(id, t)}</NavigationLabel>
    </NavigationLink>
  );
  const kindAddress = (kind: NavigationKind): string => kind.entryId === null ? FRAME_PAGES.catalogue : entityAddress(CATALOGUE_KIND, kind.entryId);
  const kindLink = (kind: NavigationKind, depth: 1 | 2): ReactElement => {
    const address = kindAddress(kind);
    return (
      <NavigationLink icon={FileTextIcon} key={kind.kind} active={here(address)} depth={depth} data-testid="nav-kind" {...link(address)}>
        <NavigationLabel>{kind.many}</NavigationLabel>
        <NavigationCount data-testid="nav-count">{kind.count}</NavigationCount>
      </NavigationLink>
    );
  };
  return (
    <>
      <BrandLink data-testid="nav-brand" concept={t('brand.concept')} {...link('/')}><ShellBrandMark /></BrandLink>
      <ProductCard name={navigation?.product ?? t('brand.product')} />
      <NavigationScroll aria-label={t('navigation.pages')} data-testid="nav-scroll">
        <NavigationLink icon={HomeIcon} active={tasks.home} aria-current={tasks.home ? 'page' : undefined} data-testid="nav-home" {...link('/')}>
          <NavigationLabel>{t('knowledge.home')}</NavigationLabel>
        </NavigationLink>
        {section('catalogue', LayoutGridIcon)}
        {section('glossary', BookOpenIcon)}
        {section('fill', RefreshCwIcon)}
        <NavigationSection data-testid="nav-waiting">
          <NavigationHeading>{t('knowledge.waiting')}</NavigationHeading>
          <NavigationLink icon={AlertTriangleIcon} active={tasks.frame === 'problems'} aria-current={tasks.frame === 'problems' ? 'page' : undefined} data-testid="nav-problems" {...link(FRAME_PAGES.problems)}>
            <NavigationLabel>{frameWord('problems', t)}</NavigationLabel>
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
        {section('documents', FolderGit2Icon)}
        {section('settings', SettingsIcon)}
      </NavigationFooter>
    </>
  );
}

/**
 * The product at the top left: its name and the space it stands in. The wiki is served for one product's graph, so the
 * menu names that product and nothing else; a server that serves a products home opens each wiki under its own address.
 */
function ProductCard({ name }: { readonly name: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ProductButton name={name} description={t('product.space')} data-testid="product-selector" aria-label={t('knowledge.chooseProduct')} />
      </DropdownMenuTrigger>
      <ShellProductMenu align="start">
        <DropdownMenuLabel>{t('knowledge.products')}</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <ShellProductLink href="." aria-current="true" data-testid="product-choice" onClick={(event) => { event.preventDefault(); }}>
            <NavigationLabel>{name}</NavigationLabel>
            <CheckIcon aria-hidden="true" size={16} />
          </ShellProductLink>
        </DropdownMenuItem>
      </ShellProductMenu>
    </DropdownMenu>
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
          <ShellRoleLabel>{role === 'all' ? name('everything') : name(role)}</ShellRoleLabel>
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

/** The top bar: where the reader stands, their role, the language and the way to read the graph again. */
export function FrameToolbar({ product, base, task, language, role, roles, busy, menu, open, onLanguage, onRole, onReload }: {
  readonly product: string | null;
  readonly base: string;
  /** The section in front, or nothing when the page is an entity's own. */
  readonly task: string | null;
  readonly language: 'en' | 'ru';
  readonly role: string;
  readonly roles: readonly string[];
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
      <ShellBreadcrumb>
        <ShellHomeLink href={base + '/'} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); open('/'); }}>{product ?? t('brand.product')}</ShellHomeLink>
        {task === null ? null : <><ShellBreadcrumbSeparator /><Text data-testid="crumb-task">{task}</Text></>}
      </ShellBreadcrumb>
      <ShellActions>
        {menu}
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
