/**
 * The knowledge wiki (decision 0029): the product chosen at the top left, the
 * kinds the product's manifest declares, and the page of one entity at a time
 * drawn from the server's page model. The app holds no kind, no template and no
 * page of its own: an empty product says what to do, and a fill that runs while
 * the page is open is read again as each commit lands.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { CheckIcon, ChevronDownIcon, FolderGit2Icon, GlobeIcon, HomeIcon, MenuIcon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { setWikiLanguage, type WikiLanguage } from '../i18n.js';
import { navigateTo } from '../hold.js';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { getProducts } from './api.js';
import { KLink } from './blocks.js';
import { EntityPage, EmptyHome, FillCard, KindPage, SourcePage, Overview } from './pages.js';
import { addressOfKind, K_HOME, kindPlural, kRouteOf, type KRoute } from './routes.js';
import type { ProductChoice, WikiStatus } from './types.js';
import { useWikiStatus } from './live.js';

/** The mockup's drawn lowercase m mark and dot, kept as one crisp vector glyph. */
function BrandMark(): ReactElement {
  return (
    <svg aria-hidden="true" className="size-[40px] shrink-0 text-ink" viewBox="0 0 50 32">
      <text x="0" y="25" fill="currentColor" fontFamily="Inter, sans-serif" fontSize="31" fontWeight="750" letterSpacing="-4">m<tspan fill="var(--text)">·</tspan></text>
    </svg>
  );
}

/** The choices the selector offers: each product's wiki address, and which one is open. */
export function productChoices(products: readonly ProductChoice[], current: string | null): { name: string; folder: string; href: string; here: boolean }[] {
  return products.map((product) => ({ name: product.name, folder: product.folder, href: `/products/${encodeURIComponent(product.folder)}${K_HOME}`, here: product.folder === current }));
}

/** The product at the top left: its name, and the other products of this server to choose from. */
export function ProductSelector({ name, products, current }: { name: string; products: readonly ProductChoice[]; current: string | null }): ReactElement {
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

function NavPanel({ status, products, route, onNavigate }: { status: WikiStatus; products: readonly ProductChoice[]; route: KRoute; onNavigate?: () => void }): ReactElement {
  const { t } = useTranslation();
  const folder = decodeURIComponent((/^\/products\/([^/]+)/.exec(window.location.pathname)?.[1] ?? ''));
  const kinds = status.kinds.filter((kind) => !kind.single);
  const pick = (address: string) => (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate?.();
    navigateTo(appPath(address));
  };
  const link = (active: boolean): string =>
    'nav-link my-px flex items-center gap-2.5 rounded-[var(--radius-row)] px-[10px] py-[9px] text-small no-underline transition-colors duration-150 motion-reduce:transition-none ' +
    (active ? 'nav-current bg-[var(--surface-active)] font-[550] text-ink' : 'text-secondary hover:bg-[var(--surface-hover)] hover:text-ink');
  return (
    <>
      <a href={appPath(K_HOME)} data-testid="nav-brand" className="nav-brand flex items-center gap-2.5 px-2 py-[14px] text-ink no-underline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2" onClick={pick(K_HOME)}>
        <BrandMark />
        <strong className="text-[23px] font-[650] leading-none tracking-[-0.8px]">madarch</strong>
        <small className="nav-concept ml-auto rounded-[var(--radius-row)] border border-line px-[5px] py-0.5 text-[11px] leading-4 text-muted">{t('brand.concept')}</small>
      </a>
      <ProductSelector name={status.product.name} products={products} current={folder === '' ? products[0]?.folder ?? null : folder} />
      <nav aria-label={t('navigation.pages')} className="min-h-0 flex-1 overflow-y-auto pb-4">
        <a href={appPath(K_HOME)} className={link(route.name === 'home')} aria-current={route.name === 'home' ? 'page' : undefined} data-testid="nav-home" onClick={pick(K_HOME)}>
          <HomeIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.home')}</span>
        </a>
        {kinds.length > 0 && <h2 className="mb-1.5 mt-4 px-2 text-[12px] uppercase tracking-[0.08em] text-muted">{t('knowledge.kinds')}</h2>}
        {kinds.map((kind) => {
          const active = route.name === 'kind' && route.kind === kind.kind;
          return (
            <a key={kind.kind} href={appPath(addressOfKind(kind.kind))} className={link(active)} aria-current={active ? 'page' : undefined} data-nav-kind={kind.kind} onClick={pick(addressOfKind(kind.kind))}>
              <span className="min-w-0 flex-1 truncate">{kindPlural(kind.kind)}</span>
              <span className="text-small text-muted">{kind.count}</span>
            </a>
          );
        })}
        <a href={appPath('/') + '?documents'} className={link(false) + ' mt-4'} data-testid="nav-documents">
          <FolderGit2Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">{t('knowledge.documents')}</span>
        </a>
      </nav>
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

/** The fill's state in the toolbar: a reader sees the wiki filling without opening anything. */
function FillChip({ status }: { status: WikiStatus }): ReactElement | null {
  const { t } = useTranslation();
  const fill = status.fill;
  if (fill.state === 'running') {
    return <Badge variant="solid" data-testid="fill-chip">{t('knowledge.fillRunning', { commit: fill.commit ?? 0, commits: fill.commits ?? 0 })}</Badge>;
  }
  if (fill.state === 'failed') return <Badge data-testid="fill-chip">{t('knowledge.fillFailed')}</Badge>;
  return null;
}

function Toolbar({ status, route, menu }: { status: WikiStatus; route: KRoute; menu: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const where = route.name === 'kind' ? kindPlural(route.kind) : route.name === 'source' ? t('knowledge.source') : route.name === 'entity' ? null : t('knowledge.home');
  return (
    <header className="shell-toolbar flex min-h-[58px] items-center justify-between gap-3 border-b border-line px-4 wide:px-[35px]">
      <span className="shell-breadcrumb min-w-0 truncate text-small text-secondary">
        <KLink href={K_HOME} className="text-muted no-underline hover:text-ink">{status.product.name}</KLink>
        {where !== null && <><span aria-hidden="true" className="px-2 text-muted">/</span><span className="text-ink">{where}</span></>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {menu}
        <FillChip status={status} />
        <LanguageMenu />
      </span>
    </header>
  );
}

export function KnowledgeApp(): ReactElement {
  const { t } = useTranslation();
  const [route, setRoute] = useState<KRoute>(() => kRouteOf(window.location.pathname, window.location.search) ?? { name: 'home' });
  const [products, setProducts] = useState<ProductChoice[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const { status, error, version, refresh } = useWikiStatus();
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPop = (): void => setRoute(kRouteOf(window.location.pathname, window.location.search) ?? { name: 'home' });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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
    if (route.name !== 'source') scroller.current?.scrollTo?.(0, 0);
  }, [route]);

  if (error !== null && status === null) {
    return <div className="grid h-dvh place-items-center bg-page p-6 text-ink [font-family:var(--font-sans)]"><p role="alert" data-testid="wiki-error">{error}</p></div>;
  }
  if (status === null) {
    return <div className="grid h-dvh place-items-center bg-page text-muted [font-family:var(--font-sans)]" data-testid="wiki-loading">{t('knowledge.loading')}</div>;
  }
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
  else view = <SourcePage key={`${route.repo ?? ''}:${route.path}`} repo={route.repo} path={route.path} line={route.line} />;
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <div className="shell flex h-dvh bg-page text-ink [font-family:var(--font-sans)] text-body" data-testid="knowledge-app">
        <aside id="app-nav" className="app-nav hidden w-[240px] wide:w-[260px] shrink-0 flex-col border-r border-line bg-chrome px-[14px] wide:px-[18px] md:flex" aria-label={t('navigation.aria')}>
          {nav()}
        </aside>
        <div className="shell-main flex min-w-0 flex-1 flex-col">
          <Toolbar status={status} route={route} menu={menu} />
          <div className="shell-row flex min-h-0 flex-1 overflow-hidden">
            <div className="shell-scroll min-w-0 flex-1 overflow-y-auto" ref={scroller}>
              <div className="shell-document w-full">
                <main data-testid="knowledge-main">
                  {status.manifest === 'no-manifest' ? <EmptyHome status={status} refresh={refresh} /> : (
                    <>
                      {!(route.name === 'home' && status.home === null) && <FillCard status={status} refresh={refresh} />}
                      {view}
                    </>
                  )}
                </main>
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

