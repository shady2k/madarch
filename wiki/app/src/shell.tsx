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
  BookOpenIcon,
  ChevronDownIcon,
  FileTextIcon,
  FolderGit2Icon,
  FocusIcon,
  MenuIcon,
  PanelRightIcon,
} from 'lucide-react';
import type { PageList, PageMeta, Product } from './api.js';
import { routeContext } from './hold.js';
import { PageLink } from './view.js';
import { Button } from '@/components/ui/button.js';
import { Toggle } from '@/components/ui/toggle.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip.js';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet.js';

/** One group of the navigation: its title and its pages in path order. */
export type NavGroup = { name: string; pages: PageMeta[] };

/** The kinds that keep their order before the remaining names sort alphabetically. */
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
  const pill = 'bg-pill hover:bg-pill';
  return [
    'nav-link my-px flex items-start gap-2.5 rounded-[5px] px-[10px] py-[11px] text-small',
    'text-secondary hover:text-ink',
    current ? 'nav-current ' + pill + ' font-[550] text-ink' : 'hover:bg-pill/60',
  ].join(' ');
}

/** The navigation content: the product's mark, its block, the tree, the footer. */
function NavPanel({ product, groups, current, onNavigate }: {
  product: Product;
  groups: readonly NavGroup[];
  current: string | undefined;
  onNavigate?: MouseEventHandler;
}): ReactElement {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
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
      <div className="nav-brand flex items-center gap-2.5 px-2 py-3.5">
        <span aria-hidden="true" className="text-[17px] font-semibold tracking-tight text-ink">m&middot;</span>
        <strong className="text-[17px] font-semibold tracking-[-0.8px] text-ink">{product.name}</strong>
      </div>
      <div
        className="mb-4 flex w-full items-center gap-2.5 rounded-[6px] border border-line bg-page px-[9px] py-[11px]"
        data-testid="product-block"
      >
        <span
          aria-hidden="true"
          className="grid size-[26px] shrink-0 place-items-center rounded-[6px] bg-ink text-[13px] font-semibold text-page"
        >
          {product.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <b className="block text-[13px] font-semibold leading-5 text-ink">{product.name}</b>
          <small className="block text-[11px] leading-4 text-muted">Product space</small>
        </span>
        <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      </div>
      <a
        className="mb-4 flex items-center gap-2.5 rounded-[5px] border border-line bg-page px-2.5 py-2 text-small text-secondary no-underline hover:bg-pill hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
        href="/"
        data-testid="nav-overview"
      >
        <BookOpenIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        Product overview
      </a>
      <div className="mb-1.5 mt-2 flex items-center justify-between px-2">
        <h2 className="text-small font-semibold uppercase tracking-[1.4px] text-muted">Documents</h2>
        <span className="text-small text-muted" data-testid="documents-count">
          {groups.reduce((n, g) => n + g.pages.length, 0)}
        </span>
      </div>
      <nav aria-label="Documents" className="min-h-0 flex-1 overflow-y-auto pb-4">
        {groups.map((group) => {
          const isOpen = !collapsed.has(group.name);
          return (
            <section key={group.name} data-nav-group={group.name} className="mb-1.5">
              <button
                className="flex min-w-0 w-full items-center gap-1.5 rounded-[5px] px-2 py-1.5 text-left text-small text-secondary hover:bg-pill hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
                aria-expanded={isOpen}
                onClick={() => toggleGroup(group.name)}
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={'size-4 shrink-0 text-muted transition-transform duration-150 ' + (isOpen ? '' : '-rotate-90')}
                />
                <span className="nav-group-title min-w-0 flex-1 truncate text-[13px] font-medium text-secondary">
                  {wordLabel(group.name)}
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
                          <FileTextIcon
                            aria-hidden="true"
                            className={'mt-[3px] size-4 shrink-0 ' + (isCurrent ? 'text-secondary' : 'text-muted')}
                          />
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
        <FolderGit2Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <Tooltip>
          {/* The folder name is what a reader recognises on their machine; the
            * product id stays reachable beneath it (the checkpoint's defect:
            * a UUID is not a name). */}
          <TooltipTrigger asChild>
            <b className="min-w-0 cursor-help truncate text-[13px] font-medium text-ink">
              {product.folder ?? product.name}
            </b>
          </TooltipTrigger>
          <TooltipContent>Product id: {product.id}</TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}

/**
 * The shell itself. Everything the app shows stands inside it: the navigation
 * panel, the toolbar (the breadcrumb on the left; the menu button, the focus
 * toggle and the context-panel place on the right), the document as `main`,
 * and the closed context panel place.
 */
export function Shell({ product, list, children }: { product: Product; list: PageList; children: ReactNode }): ReactElement {
  const route = useContext(routeContext);
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
  /* The breadcrumb names the reading: the page's kind, then its title — the
   * truth the sidebar and the heading also carry; the home page just says the
   * product. */
  const crumb = openPage === undefined ? product.name : wordLabel(groupOf(openPage.path)) + ' / ' + openPage.title;
  const classes = ['shell'];
  if (menuOpen) classes.push('nav-open');
  if (focused) classes.push('doc-only');
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <div className={classes.join(' ') + ' flex h-dvh bg-page text-ink [font-family:var(--font-sans)] text-body'}>
        <aside
          id="app-nav"
          className={'app-nav hidden w-[250px] wide:w-[270px] shrink-0 flex-col border-r border-line bg-chrome px-[14px] wide:px-[18px] md:flex'}
          aria-label="Document navigation"
          hidden={focused}
        >
          <NavPanel product={product} groups={groups} current={current} onNavigate={() => setMenuOpen(false)} />
        </aside>
        <div className="shell-main flex min-w-0 flex-1 flex-col">
          <header className="shell-toolbar flex min-h-[65px] items-center justify-between gap-3 border-b border-line px-4 wide:px-[35px] md:min-h-[58px]">
            <span className="shell-breadcrumb min-w-0 truncate text-small text-secondary">
              {crumb}
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
                    aria-label="Document navigation"
                    aria-controls="app-nav"
                    aria-expanded={menuOpen}
                  >
                    <MenuIcon aria-hidden="true" className="size-6 md:size-[22px]" />
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  data-testid="phone-nav"
                  className={'app-nav w-[min(280px,_82vw)] px-[14px] py-3 ' + (focused ? 'bg-chrome' : '')}
                >
                  <NavPanel product={product} groups={groups} current={current} onNavigate={() => setMenuOpen(false)} />
                </SheetContent>
              </Sheet>
              <Toggle
                className="shell-focus size-9"
                pressed={focused}
                onPressedChange={(next) => {
                  setMenuOpen(false);
                  setFocused(next);
                }}
                aria-label="Focus mode"
              >
                <FocusIcon aria-hidden="true" className="size-[22px]" />
              </Toggle>
              <Tooltip>
                {/* The context panel stays a closed, empty place until
                 * madarch-fe1 fills it; the toggle names that honestly. */}
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-disabled="true" aria-label="Page context" className="pointer-events-auto">
                    <PanelRightIcon aria-hidden="true" className="size-[22px]" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Page context arrives with madarch-fe1</TooltipContent>
              </Tooltip>
            </span>
          </header>
          <div className="shell-row flex min-h-0 flex-1 items-start">
            <div className="shell-document w-full">{children}</div>
            <aside className="context-panel" aria-label="Page context" hidden></aside>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
