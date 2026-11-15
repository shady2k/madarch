/**
 * The wiki's one page mechanism (decision 0036, sections 6 and 7) inside the product's frame: the product's card and its
 * sections in the sidebar, the breadcrumb and the reader's controls in the top bar, and below them the page the address
 * names. The app reads the product's bootstrap and its navigation once, composes the page its address names, and asks the
 * graph one operation for it. A press re-asks the same operation with the variables the press named; nothing of the
 * product is known here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { EVERY_ROLE, CATALOGUE_KIND, composePage, splitResponse, type Bootstrap, type PageComposition } from '../../../src/page-contract/index.js';
import { basePathOf, codesOf, postQuery, readBootstrap, readNavigation, type Navigation, type PublicationState } from './client.js';
import { reportOffline, reportOnline, setConnectionProbe, useConnection } from './connection.js';
import { ConnectionBanner } from './components/connection-banner.js';
import { readProblemsCount, readProduct, readReaderSettings, saveReaderRole, useChangeStream, useCommandRead, type ChangeNotice, type ProblemsCount, type ReaderSettingsAnswer } from './components/command.js';
import { MissingManifest } from './components/missing-manifest.js';
import { adoptProductLanguage, normalizeLanguage, setWikiLanguage } from './i18n.js';
import { frameWord, FrameNavigation, FrameToolbar, PhoneNavigation, RebuildingPage } from './frame.js';
import { pageTitleOf } from './components/header.js';
import { PageTabs } from './components/page-tabs.js';
import { pendingByKind, useLiveRun } from './components/run-indicator.js';
import { activateTab, activeAddress, closeTab, followWindow, openPage, recallTabs, rememberTabs, sessionStorageOrNull, titleTab, type TabsState } from './tabs.js';
import { KitPage } from './kit-page.js';
import { ProblemsPage } from './problems.js';
import { LogsPage } from './components/logs.js';
import { parseAddress, type FramePage } from './address.js';
import { PageView, type PageRuntime } from './page.js';
import { Alert, AlertDescription } from './components/ui/alert.js';
import {
  ShellDocument, ShellError, ShellFixed, ShellMain, ShellNavigationLoading, ShellRow, ShellScroll, ShellSidebar,
  ShellToolbarLoading,
} from './components/ui/shell.js';
import { Skeleton } from './components/ui/skeleton.js';
import { PageBreadcrumb } from './components/ui/breadcrumb.js';
import { PageSection, Paragraph, Stack } from './components/ui/typography.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { RoleFirstVisit } from './components/role-first.js';
import { STALE_STRUCTURE } from './stale.js';

const ROLE_KEY = 'madarch-wiki-role';

/** The section a template-bound address stands for, when the page has a name of the frame's own. */
function templateTask(template: string | undefined, t: TFunction): string | null {
  if (template === 'catalogue') return t('navigation.catalogue');
  if (template === 'glossary') return t('knowledge.glossary.title');
  if (template === 'search') return t('knowledge.searchResults');
  if (template === 'prepare') return t('prepare.title');
  if (template === 'runs') return t('navigation.runs');
  if (template === 'run') return t('knowledge.fillRun.title');
  if (template === 'problems') return t('loop.problemsTitle');
  if (template === 'sources') return t('navigation.documents');
  if (template === 'settings') return t('settings.title');
  return null;
}

function storedRole(): string {
  try {
    return window.localStorage.getItem(ROLE_KEY) ?? EVERY_ROLE;
  } catch {
    return EVERY_ROLE;
  }
}

function keepRole(value: string): void {
  try {
    window.localStorage.setItem(ROLE_KEY, value);
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
}

/** What one page's answer holds: its composition, the variables it was asked with, the sections' data and its address. */
interface Loaded {
  readonly composition: PageComposition;
  readonly variables: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  /** The address the answer was asked for: a page whose address moved keeps its last data until the next answer stands. */
  readonly address: string;
}

export function App(): ReactElement {
  const { i18n, t } = useTranslation();
  const language = normalizeLanguage(i18n.resolvedLanguage);
  const connection = useConnection();
  const [base] = useState(() => basePathOf(window.location.pathname));
  const [path, setPath] = useState(() => window.location.pathname.slice(base.length) + window.location.search);
  // The window's open pages: the reader's own state, kept for this window alone (a reload keeps it).
  const storage = useMemo(() => sessionStorageOrNull(), []);
  const [tabs, setTabs] = useState<TabsState>(() => recallTabs(storage, base, path));
  const tabsNow = useRef(tabs);
  const [role, setRole] = useState(storedRole);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  /** The catalogue's publication, while the graph answers that it is being made or could not be: the frame says so. */
  const [publication, setPublication] = useState<PublicationState | null>(null);
  // The run page polls its own run; the problems listing reads the whole product and would stand in its way while a
  // fill writes. Its count is read on every other page.
  const onRunPage = path.split('?')[0] === '/p/run';
  const problems = useCommandRead<ProblemsCount>('problems-count', (signal) => readProblemsCount(base, signal), !onRunPage);
  const identity = useCommandRead<{ readonly id: string; readonly name: string }>('product', (signal) => readProduct(base, signal));
  // The live fill run: read once, for the top bar's indicator and the sidebar's «still being written» counts.
  const liveRun = useLiveRun(base);
  const pending = useMemo(() => pendingByKind(liveRun.run), [liveRun.run]);
  const savedRole = useCommandRead<ReaderSettingsAnswer>('reader-settings', (signal) => readReaderSettings(base, signal));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [lastDataAt, setLastDataAt] = useState<number | null>(null);
  const [changedKinds, setChangedKinds] = useState<ReadonlySet<string>>(new Set());
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigationRequest = useRef(0);
  const [failure, setFailure] = useState<string | null>(null);
  // The graph answered NO_MANIFEST: a product whose kinds manifest a fill has still to write (madarch-64o5.133).
  const [noManifest, setNoManifest] = useState(false);
  const [busy, setBusy] = useState(false);
  const bootstrapVersion = useRef(0);
  const alive = useRef(true);
  const pageRequest = useRef(0);

  const address = useMemo(() => {
    const [pathname, search = ''] = path.split('?');
    return parseAddress(pathname ?? '/', `?${search}`, '');
  }, [path]);

  /** The tabs as the press left them: the handlers read the latest, and the bar is drawn from the state. */
  const applyTabs = useCallback((next: TabsState): void => {
    tabsNow.current = next;
    setTabs(next);
  }, []);
  useEffect(() => { rememberTabs(storage, base, tabs); }, [base, storage, tabs]);

  /** Shows the page the tab in front names: the address bar and the page below move with it, as a page load would. */
  const show = useCallback((address: string): void => {
    if (address === path) return;
    window.history.pushState({}, '', base + address);
    setPath(address);
    // A press on a link scrolls the page it opens to its top, as a page load would: the work area is the column that
    // scrolls, not the window.
    document.querySelector('[data-testid="shell-content"]')?.scrollTo({ top: 0 });
  }, [base, path]);

  /**
   * A press on a page's address: a plain press shows it in the tab in front, a control or command press in a tab of its
   * own. An address another tab already holds brings that tab forward instead of standing twice.
   */
  const open = useCallback((next: string, options?: { readonly newTab?: boolean }): void => {
    // A component names an address of the app; a rendered link carries the base the app is served under.
    const address = base !== '' && next.startsWith(base) ? next.slice(base.length) : next;
    const state = openPage(tabsNow.current, address, options?.newTab === true);
    applyTabs(state);
    show(activeAddress(state));
  }, [applyTabs, base, show]);

  /** A press on a tab brings the page it holds in front. */
  const activate = useCallback((key: string): void => {
    const state = activateTab(tabsNow.current, key);
    applyTabs(state);
    show(activeAddress(state));
  }, [applyTabs, show]);

  /** A press on a tab's close: the tab beside it comes forward when it was the one in front. */
  const close = useCallback((key: string): void => {
    const before = activeAddress(tabsNow.current);
    const state = closeTab(tabsNow.current, key);
    applyTabs(state);
    if (activeAddress(state) !== before) show(activeAddress(state));
  }, [applyTabs, show]);

  // The window's own moves — the back and forward buttons, a link the browser followed: the tab that holds that page
  // comes forward, else the tab in front names it.
  useEffect(() => {
    const follow = (): void => {
      const address = window.location.pathname.slice(base.length) + window.location.search;
      const state = followWindow(tabsNow.current, address);
      applyTabs(state);
      const shown = activeAddress(state);
      if (shown !== address) window.history.pushState({}, '', base + shown);
      setPath(shown);
    };
    window.addEventListener('popstate', follow);
    return () => { window.removeEventListener('popstate', follow); };
  }, [applyTabs, base]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadBootstrap = useCallback(async (current: () => boolean = () => alive.current): Promise<Bootstrap | undefined> => {
    const read = await readBootstrap(base, language);
    if (!alive.current || !current()) return undefined;
    // The frame's calm state stands for an unreachable server; it is not a failure of the product's page.
    if (read.offline === true) return undefined;
    // A catalogue being published, or one that could not be, is the product's own state: the frame says it in its words.
    if (read.publication !== undefined) {
      setPublication(read.publication);
      return undefined;
    }
    setPublication(null);
    bootstrapVersion.current += 1;
    if (read.bootstrap === undefined) {
      setNoManifest((read.codes ?? []).includes('NO_MANIFEST'));
      setFailure(read.message ?? 'the bootstrap could not be read');
      return undefined;
    }
    setNoManifest(false);
    setBootstrap(read.bootstrap);
    setNavigation(read.navigation ?? null);
    setLastDataAt(Date.now());
    // A reader who saved no language reads the wiki in the product's own: the first open of a product made in Russian
    // speaks Russian, and a reader's saved choice always stands (madarch-64o5.84).
    await adoptProductLanguage(read.bootstrap.language);
    return read.bootstrap;
  }, [base, language]);

  /** The frame's navigation alone: a unit publication changes its kind counts, not the product's templates. */
  const refreshNavigation = useCallback(async (): Promise<void> => {
    const request = ++navigationRequest.current;
    const read = await readNavigation(base, language);
    if (!alive.current || request !== navigationRequest.current) return;
    if (read.navigation === undefined) return;
    setNavigation(read.navigation);
    setLastDataAt(Date.now());
  }, [base, language]);

  // The probe that lifts the calm state: the product read the server answers first, without touching the graph.
  useEffect(() => setConnectionProbe(async () => {
    const answer = await fetch(`${base}/api/product`, { credentials: 'same-origin', cache: 'no-store' });
    if (answer.ok) reportOnline();
    else if (answer.status === 503) reportOffline('starting');
    else if (answer.status === 502 || answer.status === 504) reportOffline();
    else if (answer.status >= 500) throw new Error(`the server answered ${String(answer.status)}`);
  }), [base]);

  // A returned server is a reason to read the frame and its page again; the last generation makes that one read.
  const lastGeneration = useRef(connection.generation);
  useEffect(() => {
    if (connection.generation === lastGeneration.current) return;
    lastGeneration.current = connection.generation;
    void loadBootstrap();
  }, [connection.generation, loadBootstrap]);

  // The bootstrap and the navigation are read once per structure and language: what they hold changes only with the
  // product's files or the reader's language.
  useEffect(() => {
    setBootstrap(null);
    void loadBootstrap();
  }, [loadBootstrap]);

  // The saved role is the active role on every browser, not only in the first-visit dialog. A role changed on this page or
  // in Settings is applied by `applyRole` and, for the top bar's menu, saved back to the same file.
  useEffect(() => {
    if (savedRole.data === null || typeof savedRole.data.role !== 'string') return;
    setRole(savedRole.data.role);
    keepRole(savedRole.data.role);
  }, [savedRole.data]);

  const ask = useCallback(async (composition: PageComposition, variables: Record<string, unknown>, asked: string): Promise<void> => {
    const request = ++pageRequest.current;
    const current = (): boolean => alive.current && request === pageRequest.current;
    setBusy(true);
    const answer = await postQuery<Record<string, unknown>>(base, composition.operation, variables);
    if (!current()) return;
    setBusy(false);
    // The frame's calm state stands for the unreachable server, and the page keeps what it last held.
    if (answer.offline === true) return;
    if (answer.publication !== undefined) {
      setPublication(answer.publication);
      return;
    }
    setPublication(null);
    const codes = codesOf(answer.errors);
    if (answer.errors.length > 0) {
      if (codes.includes(STALE_STRUCTURE) && bootstrap !== null) {
        const read = await loadBootstrap(current);
        if (current() && read !== undefined) {
          const again = composePage(read, { ...address.page, lang: language, role, ...(address.home ? { home: true } : {}) });
          if (again.findings.length === 0) await ask(again, again.variables, asked);
        }
        return;
      }
      setFailure(answer.errors.map((error) => error.message).join('; '));
      return;
    }
    setFailure(null);
    setLastDataAt(Date.now());
    setLoaded({ composition, variables, data: splitResponse(composition, answer.data ?? {}), address: asked });
  }, [address, base, bootstrap, language, loadBootstrap, role]);

  // One page view, one operation: the page is composed from the bootstrap and the address, then asked once.
  const compositionKey = `${language}\u0000${role}\u0000${path}\u0000${bootstrap?.structureRevision ?? ''}\u0000${String(bootstrapVersion.current)}`;
  useEffect(() => {
    if (bootstrap === null) return;
    if (address.unknown) {
      setFailure(`no page stands at ${window.location.pathname}`);
      setLoaded(null);
      return;
    }
    // A section of the frame whose page is not rebuilt yet says so, and asks the graph for nothing.
    if (address.frame !== null) {
      setFailure(null);
      setLoaded(null);
      return;
    }
    // An older product may have no `problems` template: its Problems page is the frame's template-findings page, not a
    // composition finding. A product with the template draws its own listing.
    if ((address.page.template === 'problems' || address.page.template === 'logs') && !bootstrap.templates.some((one) => one.name === address.page.template)) {
      setFailure(null);
      setLoaded(null);
      return;
    }
    const composition = composePage(bootstrap, { ...address.page, lang: language, role });
    if (composition.findings.length > 0) {
      setFailure(composition.findings.map((finding) => `${finding.file}:${String(finding.line)}: ${finding.message}`).join('\n'));
      setLoaded(null);
      return;
    }
    // A page whose sections ask the graph nothing (`fill`, `run`) is drawn from the command reads alone: it sends no
    // empty operation, and the page's own components make their requests.
    if (composition.operation === '') {
      setFailure(null);
      setBusy(false);
      setLoaded({ composition, variables: composition.variables, data: {}, address: path });
      return;
    }
    void ask(composition, composition.variables, path);
    return () => { pageRequest.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositionKey]);

  const reload = useCallback((variables: Record<string, unknown>): void => {
    if (loaded === null) return;
    const merged = { ...loaded.variables, ...variables };
    // A key set to null drops the variable, as the connection's own default asks.
    for (const [key, value] of Object.entries(variables)) if (value === null) delete merged[key];
    void ask(loaded.composition, merged, loaded.address);
  }, [ask, loaded]);

  /**
   * A change notice: a unit publication names the kinds it moved, so the frame reads only its navigation and, when the
   * page shows one of those kinds, that page; a structure notice is the product's files or templates moving, and the
   * whole frame reads again. The changed kinds wear a short highlight.
   */
  const replyToNotice = useCallback((notice: ChangeNotice): void => {
    problems.reload();
    if (notice.structure === true || notice.kinds === undefined || notice.kinds.length === 0) {
      void loadBootstrap();
      return;
    }
    const kinds = notice.kinds;
    setChangedKinds((held) => new Set([...held, ...kinds]));
    if (highlightTimer.current !== undefined) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      highlightTimer.current = undefined;
      setChangedKinds(new Set());
    }, 2000);
    void refreshNavigation();
    // The home shows the counts in its own sections, and an older template reads them from its own query: the home reads
    // its page again. A catalogue entry page lists the kind its entry names, so that kind's change reads the entry page;
    // an entity page reads again only when its own kind changed.
    const kind = address.page.kind === CATALOGUE_KIND && address.page.id !== undefined
      ? navigation?.kinds.find((one) => one.entryId === address.page.id)?.kind
      : address.page.kind;
    if (address.home === true || (kind !== undefined && kinds.includes(kind))) reload({});
  }, [address.home, address.page.id, address.page.kind, loadBootstrap, navigation, problems.reload, refreshNavigation, reload]);

  // The product's one event stream: a unit publication changes counts, a structure notice changes the frame.
  useChangeStream(base, replyToNotice);
  useEffect(() => () => { if (highlightTimer.current !== undefined) clearTimeout(highlightTimer.current); }, []);

  const productName = identity.data?.name ?? navigation?.product ?? null;
  const applyRole = useCallback((next: string): void => { setRole(next); keepRole(next); }, []);
  const chooseRole = useCallback((next: string): void => { applyRole(next); void saveReaderRole(base, next).catch(() => undefined); }, [applyRole, base]);
  const section: FramePage | null = address.frame;
  // The page's own name when the address names a frame page or a template page; an entity's page trails its kind.
  const pageName = address.home ? t('knowledge.home') : section !== null ? frameWord(section, t) : templateTask(address.page.template, t);
  // The tab's name: the product on its home, the page's own title once its answer stands, else the page's frame word.
  // The page's own name is read from the answer that stands for the address in front, never from the last page's.
  const loadedTitle = loaded === null || loaded.address !== path ? null : pageTitleOf(loaded.composition, loaded.data, language);
  const knownTitle = address.home ? productName : loadedTitle ?? pageName;
  // A page names its tab when its name is known: an entity's tab says «Loading…» until the page stands, then its title.
  useEffect(() => {
    if (knownTitle === null) return;
    applyTabs(titleTab(tabsNow.current, tabsNow.current.active, knownTitle));
  }, [applyTabs, knownTitle, path]);
  // The document says the language the reader reads and names the page beside the product, as the browser's tab shows them.
  useEffect(() => {
    document.documentElement.lang = language;
    const product = productName ?? navigation?.product ?? 'madarch';
    document.title = knownTitle === null || knownTitle === product
      ? t('knowledge.title', { product })
      : t('knowledge.titleOf', { page: knownTitle, product });
  }, [knownTitle, language, navigation?.product, productName, t]);
  // A catalogue being published, or one that could not be, is read again by itself: the frame waits on the product it shows.
  useEffect(() => {
    if (publication === null) return;
    const timer = setTimeout(() => { void loadBootstrap(); }, publication.status === 'pending' ? 1000 : 5000);
    return () => { clearTimeout(timer); };
  }, [publication, loadBootstrap]);
  const runtime: PageRuntime = { base, language, busy, variables: loaded?.variables ?? {}, product: productName, navigation, pageName, role, open, reload, onRole: applyRole, changedKinds };
  const here = `/${path.split('?')[0] ?? ''}`;
  const tasks = { home: address.home, frame: section };
  // The groups the reader's role lists first (decision 0031), as the product's manifest declares them.
  const leads = bootstrap?.roleLeads.find((one) => one.role === role)?.lead ?? [];
  const navigationPanel = (after: () => void): ReactElement => (
    <FrameNavigation
      navigation={navigation}
      base={base}
      path={here}
      open={(next, options) => { open(next, options); after(); }}
      tasks={tasks}
      role={role}
      leads={leads}
      problemsOpen={problems.data?.open ?? null}
      productName={productName}
      pending={pending}
      changed={changedKinds}
    />
  );
  const [menuOpen, setMenuOpen] = useState(false);
  // A product that has no kinds manifest has no graph to ask: the frame names the file and the guide that writes one,
  // instead of the failure the empty catalogue would raise (madarch-64o5.133).
  if (bootstrap === null && !connection.offline && noManifest) {
    return (
      <ShellError>
        <MissingManifest product={identity.data?.name ?? null} status={null} />
      </ShellError>
    );
  }
  // The graph could not be read at all, the server cannot be reached, or the catalogue is being published: the frame
  // says so instead of a page.
  if (bootstrap === null && (failure !== null || connection.offline || publication !== null)) {
    return (
      <ShellError>
        {connection.offline
          ? <ConnectionBanner lastDataAt={lastDataAt} />
          : publication !== null
            ? <PublicationNote publication={publication} />
            : <Paragraph role="alert" data-testid="wiki-error">{failure}</Paragraph>}
      </ShellError>
    );
  }
  // The first read: the frame stands with its shapes, and nothing of the product is drawn yet.
  if (bootstrap === null) {
    return (
      <Stack layout="shell" data-testid="wiki-loading">
        <ShellSidebar loading aria-hidden="true"><ShellNavigationLoading /></ShellSidebar>
        <ShellMain>
          <ShellToolbarLoading />
          <ShellScroll data-testid="shell-content">
            <ShellDocument>
              <main>
                <PageSection><Skeleton className="h-9 w-72" /></PageSection>
                <PageSection><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-64" /></PageSection>
              </main>
            </ShellDocument>
          </ShellScroll>
        </ShellMain>
      </Stack>
    );
  }
  // The kit and template findings have frame pages; other sections wait for their pages. A product without a
  // `problems` template still has the frame's template-findings page at the same address, and a product created before
  // the logs template existed opens the frame's Logs page — the machine's logs are not the product's files.
  const page = section !== null
    ? section === 'kit' ? <KitPage /> : <RebuildingPage word={frameWord(section, t)} />
    : address.page.template === 'problems' && !bootstrap.templates.some((one) => one.name === 'problems')
      ? <ProblemsPage base={base} />
      : address.page.template === 'logs' && !bootstrap.templates.some((one) => one.name === 'logs')
        ? <LogsPage base={base} />
        : null;
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <RoleFirstVisit base={base} onChosen={applyRole} />
      <Stack layout="shell" data-testid="wiki-app">
        <ShellSidebar id="app-nav" aria-label={t('navigation.aria')}>
          <Stack layout="navigation">{navigationPanel(() => undefined)}</Stack>
        </ShellSidebar>
        <ShellMain>
          <ShellFixed data-testid="shell-fixed">
            <FrameToolbar
              base={base}
              language={language}
              role={role}
              roles={bootstrap.roles}
              navigation={navigation}
              busy={busy}
              menu={<PhoneNavigation open={menuOpen} onOpenChange={setMenuOpen}>{navigationPanel(() => { setMenuOpen(false); })}</PhoneNavigation>}
              open={open}
              run={liveRun}
              onLanguage={(next) => { void setWikiLanguage(next); }}
              onRole={chooseRole}
              onReload={() => { void loadBootstrap(); }}
            />
            <PageTabs tabs={tabs.tabs} active={tabs.active} activate={activate} close={close} />
          </ShellFixed>
          <ShellRow>
            <ShellScroll data-testid="shell-content">
              <ShellDocument>
                <main data-testid="wiki-main">
                  <ConnectionBanner lastDataAt={lastDataAt} />
                  {publication === null || connection.offline ? null : <PublicationNote publication={publication} />}
                  {failure === null ? null : (
                    <Alert variant="problem" className="mb-4" data-testid="wiki-error">
                      <AlertDescription>{failure}</AlertDescription>
                    </Alert>
                  )}
                  <Stack className={connection.offline ? 'opacity-60 transition-opacity' : 'transition-opacity'} data-testid="page-content" data-stale={connection.offline ? 'true' : 'false'}>
                    {section === null ? null : <PageBreadcrumb label={t('knowledge.breadcrumb')} items={[{ label: frameWord(section, t) }]} />}
                    {page}
                    {loaded === null ? null : <PageView composition={loaded.composition} data={loaded.data} runtime={runtime} />}
                  </Stack>
                </main>
              </ShellDocument>
            </ShellScroll>
          </ShellRow>
        </ShellMain>
      </Stack>
    </TooltipProvider>
  );
}

/**
 * The catalogue's own state (decision 0036, section 8): while the product's catalogue is being published, and when it
 * could not be, the frame says so in the reader's language instead of drawing a page over nothing.
 */
function PublicationNote({ publication }: { readonly publication: PublicationState }): ReactElement {
  const { t } = useTranslation();
  const pending = publication.status === 'pending';
  return (
    <Alert
      variant="problem"
      className="mb-4"
      role={pending ? 'status' : 'alert'}
      data-publication={publication.status}
      data-testid="publication-note"
    >
      <AlertDescription>
        {pending ? t('knowledge.publishing') : t('knowledge.publishingFailed', { message: publication.message ?? '' })}
      </AlertDescription>
    </Alert>
  );
}
