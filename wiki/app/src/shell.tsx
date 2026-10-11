/**
 * The reading shell, restyled on the mockup's structure: the left navigation
 * panel (the madarch mark, the product block with its initial on a dark
 * square, the Product overview entry, the DOCUMENTS heading, kind groups with
 * collapse chevrons and document counts, lucide document icons and wrapped
 * titles, the open page on its grey pill, the product folder's name in the
 * footer), the top bar (a kind / title breadcrumb on the left, lucide focus
 * and context toggles on the right), the document in the centre, and the
 * closed context panel place. On narrow widths (<=700 px) the navigation
 * opens from the toolbar as a shadcn Sheet drawer; the document column is
 * never narrowed by the panel. Styling rides Tailwind v4 utilities and the
 * design tokens (styles/tokens.css stays the values source).
 *
 * Grouping rule (the coordinator's decision on the change): a page whose path
 * is README.md or docs/<file>.md belongs to the "product" group; a page
 * docs/<folder>/<file>.md belongs to that folder's group; any other path
 * belongs to "other". Groups stand in the order product, requirements,
 * decisions, research, then the remaining group names alphabetically in code
 * point order ("other" sorts with them); pages inside a group stand in their
 * path's code point order.
 */
import { useEffect, useRef, useState, useContext, type ReactElement, type ReactNode, type MouseEventHandler } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  FileTextIcon,
  FolderGit2Icon,
  GlobeIcon,
  MenuIcon,
  NetworkIcon,
  PanelRightIcon,
} from 'lucide-react';
import type { PageList, PageMeta, Product } from './api.js';
import { architectureAddress } from './routes.js';
import type { Architecture } from './api.js';
import { useTranslation } from 'react-i18next';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { setWikiLanguage, type WikiLanguage } from './i18n.js';
import { routeContext, statusContext } from './hold.js';
import { PageLink } from './view.js';
import { Button } from '@/components/ui/button.js';
import { Toggle } from '@/components/ui/toggle.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip.js';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet.js';

/** The mockup's drawn lowercase m mark and dot, kept as one crisp vector glyph. */
function BrandMark(): ReactElement {
  return (
    <svg aria-hidden="true" className="size-[40px] shrink-0 text-ink" viewBox="0 0 50 32">
      <text x="0" y="25" fill="currentColor" fontFamily="Inter, sans-serif" fontSize="31" fontWeight="750" letterSpacing="-4">m<tspan fill="var(--text)">·</tspan></text>
    </svg>
  );
}

/** The mockup's four-corner focus glyph. */
function FocusGlyph(): ReactElement {
  return (
    <svg aria-hidden="true" className="size-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

/** The mockup's narrow striped context-panel glyph. */
function StripedPanelGlyph(): ReactElement {
  return (
    <svg aria-hidden="true" className="size-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6 3.5v17M10 3.5v17M14 3.5v17M18 3.5v17" />
    </svg>
  );
}

/** Filled document glyph from the mockup, with its paper lines knocked out. */
function FilledDocumentGlyph({ className }: { className: string }): ReactElement {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16">
      <path fill="currentColor" d="M3 1.5h6.2L13 5.3v9.2H3z" />
      <path fill="none" stroke="var(--bg-page)" strokeWidth=".8" d="M9 1.8v3.8h3.7M5 8h6M5 10.5h6M5 13h4" />
    </svg>
  );
}

/** One group of the navigation: its title and its pages in path order. */
export type NavGroup = { name: string; pages: PageMeta[] };

/** The kinds that keep their order before the remaining names sort alphabetically. The architecture entry rides the same life-cycle order: the Design stage's part, after the decisions. */
const fixedGroupOrder = ['product', 'requirements', 'decisions', 'research'] as const;

/** The group a page's path belongs to, by the grouping rule. */
export function groupOf(path: string): string {
  if (path === 'README.md') return 'product';
  if (path.startsWith('docs/')) {
    const rest = path.slice('docs/'.length);
    const parts = rest.split('/');
    if (parts.length === 1) return 'product'; // docs/<file>.md
    if (parts.length === 2) return parts[0] as string; // docs/<folder>/<file>.md
  }
  return 'other';
}

/**
 * The page's kind word for the eyebrow and the breadcrumb: its group's kind,
 * with the mockup's two special readings - the README page names itself, a
 * product-group page that is not the README carries the file stem
 * (docs/vision.md reads VISION). The group names come from real paths, so the
 * eyebrow never invents a kind the product does not hold.
 */
/**
 * The group's word for a reader: the labels the sidebar, the home page and
 * the breadcrumb use, sentence case (the checkpoint's defect: slugs are for
 * paths, not for people).
 */
export function wordLabel(group: string): string {
  const words: Record<string, string> = {
    product: 'Product',
    requirements: 'Requirements',
    decisions: 'Decisions',
    research: 'Research',
    prototypes: 'Prototypes',
    results: 'Results',
    stories: 'Stories',
    sources: 'Sources',
    hypotheses: 'Hypotheses',
    questions: 'Questions',
    'use-cases': 'Use cases',
    other: 'Other',
  };
  const word = words[group];
  if (word !== undefined) return word;
  if (group === '') return 'Other';
  return group.charAt(0).toUpperCase() + group.slice(1);
}

export function kindOf(path: string, group: string): string {
  if (path === 'README.md') return 'README';
  if (group === 'product') {
    const base = path.split('/').pop() ?? path;
    return base.replace(/\.md$/, '').toUpperCase();
  }
  // requirements -> REQUIREMENT, decisions -> DECISION, research -> RESEARCH:
  // the group name names the kind, the trailing s is the group's generality.
  return (group.endsWith('s') ? group.slice(0, -1) : group).toUpperCase();
}

/**
 * A code point comparison: smaller first, equal never reorders. UTF-16
 * `<` orders surrogate pairs wrongly (a private-use BMP code point sorts
 * after an astral one), so the comparison runs over code points.
 */
export function byCodePoint(a: string, b: string): number {
  const ca = [...a].map((ch) => ch.codePointAt(0) ?? 0);
  const cb = [...b].map((ch) => ch.codePointAt(0) ?? 0);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i] as number, y = cb[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (ca.length === cb.length) return 0;
  return ca.length < cb.length ? -1 : 1;
}

/**
 * The navigation groups for a page list: grouped by the rule, fixed kinds
 * first, remaining names alphabetical, pages in each group in code point
 * order of their paths.
 */
export function groupNav(pages: readonly PageMeta[]): NavGroup[] {
  const byGroup = new Map<string, PageMeta[]>();
  for (const page of pages) {
    const name = groupOf(page.path);
    const held = byGroup.get(name);
    if (held === undefined) byGroup.set(name, [page]);
    else held.push(page);
  }
  const names = [...byGroup.keys()];
  names.sort((a, b) => byCodePoint(a, b));
  const ordered = [
    ...fixedGroupOrder.filter((name) => byGroup.has(name)),
    ...names.filter((name) => !(fixedGroupOrder as readonly string[]).includes(name)),
  ];
  return ordered.map((name) => {
    const held = byGroup.get(name) as PageMeta[];
    const sorted = [...held].sort((a, b) => byCodePoint(a.path, b.path));
    return { name, pages: sorted };
  });
}

/** The classes of one navigation page link: the grey pill on the open page. */
export function navLinkClasses(current: boolean): string {
  const pill = 'bg-[var(--surface-active)] hover:bg-[var(--surface-active)]';
  return [
    'nav-link my-px flex items-start gap-2.5 rounded-[var(--radius-row)] pl-[38px] pr-[10px] py-[11px] text-small transition-colors duration-150 motion-reduce:transition-none',
    'text-secondary hover:text-ink',
    current ? 'nav-current ' + pill + ' font-[550] text-ink' : 'hover:bg-[var(--surface-hover)]',
  ].join(' ');
}

/** The navigation content: the product's mark, its block, the tree, the footer. */
function NavPanel({ product, groups, current, onNavigate, architectureCount }: {
  product: Product;
  groups: readonly NavGroup[];
  current: string | undefined;
  onNavigate?: MouseEventHandler;
  /** The Architecture section's view count, when the model holds views. */
  architectureCount?: number;
}): ReactElement {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { t } = useTranslation();
  const toggleGroup = (name: string): void => {
    setCollapsed((held) => {
      const next = new Set(held);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  return (
    <>
      <div className="nav-brand flex items-center gap-2.5 px-2 py-[14px]">
        <BrandMark />
        <strong className="text-[23px] font-[650] leading-none tracking-[-0.8px] text-ink">madarch</strong>
        <small className="nav-concept ml-auto rounded-[var(--radius-row)] border border-line px-[5px] py-0.5 text-[11px] leading-4 text-muted">{t('brand.concept')}</small>
      </div>
      <div
        className="nav-product-block mb-3 flex w-full items-start gap-2.5 rounded-[var(--radius-card)] border border-line bg-[var(--surface-card)] px-[9px] py-2 shadow-[var(--shadow-low)]"
        data-testid="product-block"
      >
        <span
          aria-hidden="true"
          className="product-initial grid size-[40px] shrink-0 place-items-center rounded-[var(--radius-control)] bg-white font-serif text-[22px] font-medium text-[#252525] shadow-[var(--shadow-low)]"
        >
          {product.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <b className="block text-[13px] leading-5 text-ink">{product.name}</b>
          <small className="block text-[11px] leading-4 text-muted">{t('product.space')}</small>
        </span>
        <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      </div>
      <a
        className="mb-3 flex items-center justify-between rounded-[var(--radius-row)] px-2.5 py-2 text-[13px] text-ink no-underline hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
        href="/"
        data-testid="nav-overview"
      >
        <span className="flex items-center gap-2.5"><PanelRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted" /> {t('navigation.overview')}</span>
      </a>
      {/* The Architecture section (feature E): the Design stage's part of the
       * life cycle, the views' index and the model's elements behind it. The
       * entry stands even where the model is missing or refuses to compile —
       * the page says what is wrong, never an empty box. */}
      <a
        className="mb-3 flex items-center justify-between rounded-[var(--radius-row)] px-2.5 py-2 text-[13px] text-ink no-underline hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
        href={architectureAddress()}
        data-testid="nav-architecture"
      >
        <span className="flex items-center gap-2.5"><NetworkIcon aria-hidden="true" className="size-4 shrink-0 text-muted" /> {t('architecture.title')}</span>
        {architectureCount !== undefined && <span className="text-small text-muted">{architectureCount}</span>}
      </a>
      <div className="mb-1.5 mt-2 flex items-center justify-between px-2">
        <h2 className="text-[12px] uppercase tracking-[0.08em] text-muted">{t('navigation.documents')}</h2>
        <span className="text-small text-muted" data-testid="documents-count">
          {groups.reduce((n, g) => n + g.pages.length, 0)}
        </span>
      </div>
      <nav aria-label={t('navigation.documents')} className="min-h-0 flex-1 overflow-y-auto pb-4">
        {groups.map((group) => {
          const isOpen = !collapsed.has(group.name);
          return (
            <section key={group.name} data-nav-group={group.name} className="mb-1.5">
              <button
                className="flex min-w-0 w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 py-1.5 text-left text-small text-secondary hover:bg-[var(--surface-hover)] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
                aria-expanded={isOpen}
                onClick={() => toggleGroup(group.name)}
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={'size-4 shrink-0 text-muted transition-transform duration-150 ' + (isOpen ? '' : '-rotate-90')}
                />
                <span className="nav-group-title min-w-0 flex-1 truncate text-[13px] text-secondary">
                  {t('groups.' + group.name, { defaultValue: wordLabel(group.name) })}
                </span>
                <span className="text-small text-muted">{group.pages.length}</span>
              </button>
              {isOpen && (
                <ul className="m-0 list-none p-0">
                  {group.pages.map((page) => {
                    const isCurrent = current === page.path;
                    return (
                      <li key={page.path} onClick={onNavigate}>
                        <PageLink
                          path={page.path}
                          className={navLinkClasses(isCurrent)}
                          ariaCurrent={isCurrent ? 'page' : undefined}
                        >
                          <FilledDocumentGlyph className={'mt-[3px] size-4 shrink-0 ' + (isCurrent ? 'text-secondary' : 'text-muted')} />
                          <span className="min-w-0 whitespace-normal leading-snug">{page.title}</span>
                        </PageLink>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
      <div className="mt-2 flex items-center gap-2.5 border-t border-line px-1 py-3">
        <FolderGit2Icon aria-hidden="true" className="size-[18px] shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13px] font-medium text-ink">{product.folder ?? product.name}</b>
          <small className="block truncate text-[11px] leading-4 text-muted">{t('product.local')}</small>
        </span>
      </div>
    </>
  );
}

/** The shell's bottom status bar: what is open publishes its parts; nothing open shows nothing. */
export function StatusBar(): ReactElement {
  const { parts, connection } = useContext(statusContext);
  const { t } = useTranslation();
  return (
    <footer className="statusbar" role="contentinfo">
      <span className="status-connection" data-testid="connection-status" data-state={connection} aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        {connection === 'live' ? t('status.live') : t('status.reconnecting')}
      </span>
      <span className="status-details">
        {parts?.map((part, at) => (
          <span key={at} data-testid={at === 0 ? 'word-count' : undefined}>{part}</span>
        ))}
      </span>
    </footer>
  );
}

/**
 * The shell itself. Everything the app shows stands inside it: the navigation
 * panel, the toolbar (the breadcrumb on the left; the menu button, the focus
 * toggle and the context-panel place on the right), the document toolbar —
 * the tab strip row carrying the open file's name — the document inside its
 * own scrolling column (the only scrolling part at any window height), and
 * the status bar along the window's bottom edge.
 */
export function Shell({ product, list, children, architecture }: { product: Product; list: PageList; children: ReactNode; architecture?: Architecture | null }): ReactElement {
  const route = useContext(routeContext);
  const { t, i18n } = useTranslation();
  const language: WikiLanguage = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  // The focus choice stays for the open page only: another page opens unfocused.
  useEffect(() => {
    setFocused(false);
  }, [route.path]);
  // Escape closes the opened phone menu and focus returns to the menu button.
  useEffect(() => {
    if (!menuOpen) return;
    const press = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuRef.current?.focus();
    };
    document.addEventListener('keydown', press);
    return () => document.removeEventListener('keydown', press);
  }, [menuOpen]);
  const current = route.path;
  const groups = groupNav(list.pages);
  const openPage = current === undefined ? undefined : list.pages.find((page) => page.path === current);
  const classes = ['shell'];
  if (menuOpen) classes.push('nav-open');
  if (focused) classes.push('doc-only');
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <div className={classes.join(' ') + ' flex h-dvh bg-page text-ink [font-family:var(--font-sans)] text-body'}>
        <aside
          id="app-nav"
          className={'app-nav hidden w-[240px] wide:w-[260px] shrink-0 flex-col border-r border-line bg-chrome px-[14px] wide:px-[18px] md:flex'}
          aria-label={t('navigation.aria')}
          hidden={focused}
        >
          <NavPanel product={product} groups={groups} current={current} onNavigate={() => setMenuOpen(false)} architectureCount={architecture?.model?.views.length} />
        </aside>
        <div className="shell-main flex min-w-0 flex-1 flex-col">
          <header className="shell-toolbar flex min-h-[58px] items-center justify-between gap-3 border-b border-line px-4 wide:px-[35px]">
            <span className="shell-breadcrumb min-w-0 truncate text-small text-secondary">
              {openPage === undefined ? (
                t('navigation.overview')
              ) : (
                <>
                  <span className="text-muted">{t('groups.' + groupOf(openPage.path), { defaultValue: wordLabel(groupOf(openPage.path)) })}</span>{' '}
                  <span aria-hidden="true" className="px-2 text-muted">/</span>{' '}
                  <span className="text-ink">{openPage.title}</span>
                </>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {/*
               * The phone menu opens the navigation as the Sheet drawer; the
               * document column stands at its own width behind the overlay.
               */}
              <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                <SheetTrigger asChild>
                  <Button
                    ref={menuRef}
                    className="shell-menu md:!hidden"
                    aria-label={t('navigation.aria')}
                    aria-controls="app-nav"
                    aria-expanded={menuOpen}
                  >
                    <MenuIcon aria-hidden="true" className="size-6 md:size-[22px]" />
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  title={t('navigation.aria')}
                  closeLabel={t('navigation.close')}
                  data-testid="phone-nav"
                  className={'app-nav w-[min(280px,_82vw)] px-[14px] py-3 ' + (focused ? 'bg-chrome' : '')}
                >
                  <NavPanel product={product} groups={groups} current={current} onNavigate={() => setMenuOpen(false)} architectureCount={architecture?.model?.views.length} />
                </SheetContent>
              </Sheet>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shell-language size-9"
                    aria-label={t('navigation.language')}
                    title={t('tooltips.language')}
                  >
                    <GlobeIcon aria-hidden="true" className="size-[21px]" />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={7} className="language-menu">
                    <DropdownMenu.Label className="language-menu-label">{t('navigation.language')}</DropdownMenu.Label>
                    <DropdownMenu.Separator className="language-menu-separator" />
                    <DropdownMenu.RadioGroup
                      value={language}
                      onValueChange={(value: string) => {
                        if (value === 'en' || value === 'ru') void setWikiLanguage(value);
                      }}
                    >
                      <DropdownMenu.RadioItem className="language-menu-item" value="ru">
                        <span className="language-menu-check"><DropdownMenu.ItemIndicator><CheckIcon aria-hidden="true" className="size-4" /></DropdownMenu.ItemIndicator></span>
                        {t('navigation.russian')}
                      </DropdownMenu.RadioItem>
                      <DropdownMenu.RadioItem className="language-menu-item" value="en">
                        <span className="language-menu-check"><DropdownMenu.ItemIndicator><CheckIcon aria-hidden="true" className="size-4" /></DropdownMenu.ItemIndicator></span>
                        {t('navigation.english')}
                      </DropdownMenu.RadioItem>
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <Toggle
                className="shell-focus size-9"
                pressed={focused}
                onPressedChange={(next) => {
                  setMenuOpen(false);
                  setFocused(next);
                }}
                aria-label={t('navigation.focus')}
              >
                <FocusGlyph />
              </Toggle>
              <Tooltip>
                {/* The context panel stays a closed, empty place until
                 * madarch-fe1 fills it; the toggle names that honestly. */}
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-disabled="true" aria-label={t('navigation.context')} className="shell-context pointer-events-auto">
                    <StripedPanelGlyph />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('navigation.contextUnavailable')}</TooltipContent>
              </Tooltip>
            </span>
          </header>
          {/* The tab strip row under the top bar: the open file's name on its
           * tab. The mockup's view switch and history button stay out until
           * they work (madarch-j0a); the row's structure stands now. */}
          <div className="document-bar flex min-h-[45px] items-stretch bg-ground">
            <div className="document-tab flex min-w-[182px] items-center gap-2 border-r border-line bg-page px-[25px] text-[13px] text-secondary" data-testid="document-tab">
              <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
              <span className="truncate">{openPage?.path.split('/').pop() ?? t('navigation.overview')}</span>
            </div>
          </div>
          {/* The window-height shell: every panel and bar stays in place and
           * the ONLY scrolling lives in the document's own column — the home
           * page scrolls here too. */}
          <div className="shell-row flex min-h-0 flex-1 overflow-hidden">
            <div className="shell-scroll min-w-0 flex-1 overflow-y-auto">
              <div className="shell-document w-full">{children}</div>
            </div>
            <aside className="context-panel" aria-label={t('navigation.context')} hidden></aside>
          </div>
          <StatusBar />
        </div>
      </div>
    </TooltipProvider>
  );
}
