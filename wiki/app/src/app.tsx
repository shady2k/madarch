/**
 * The wiki's one page mechanism (decision 0036, sections 6 and 7) inside the product's frame: the product's card and its
 * sections in the sidebar, the breadcrumb and the reader's controls in the top bar, and below them the page the address
 * names. The app reads the product's bootstrap and its navigation once, composes the page its address names, and asks the
 * graph one operation for it. A press re-asks the same operation with the variables the press named; nothing of the
 * product is known here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { composePage, splitResponse, type Bootstrap, type PageComposition } from '../../../src/page-contract/index.js';
import { basePathOf, codesOf, postQuery, readBootstrap, type Navigation } from './client.js';
import { normalizeLanguage, setWikiLanguage } from './i18n.js';
import { frameWord, FrameNavigation, FrameToolbar, PhoneNavigation, RebuildingPage } from './frame.js';
import { KitPage } from './kit-page.js';
import { parseAddress, type FramePage } from './address.js';
import { PageView, type PageRuntime } from './page.js';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import {
  ShellDocument, ShellError, ShellFixed, ShellMain, ShellNavigationLoading, ShellRow, ShellScroll, ShellSidebar,
  ShellToolbarLoading,
} from './components/ui/shell.js';
import { Skeleton } from './components/ui/skeleton.js';
import { PageSection, Paragraph, Stack } from './components/ui/typography.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { STALE_STRUCTURE } from './stale.js';

const ROLE_KEY = 'madarch-wiki-role';

function storedRole(): string {
  try {
    return window.localStorage.getItem(ROLE_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

function keepRole(value: string): void {
  try {
    window.localStorage.setItem(ROLE_KEY, value);
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
}

/** What one page's answer holds: its composition, the variables it was asked with and the sections' data. */
interface Loaded {
  readonly composition: PageComposition;
  readonly variables: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

export function App(): ReactElement {
  const { i18n, t } = useTranslation();
  const language = normalizeLanguage(i18n.resolvedLanguage);
  const [base] = useState(() => basePathOf(window.location.pathname));
  const [path, setPath] = useState(() => window.location.pathname.slice(base.length) + window.location.search);
  const [role, setRole] = useState(storedRole);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bootstrapVersion = useRef(0);
  const alive = useRef(true);

  const address = useMemo(() => {
    const [pathname, search = ''] = path.split('?');
    return parseAddress(pathname ?? '/', `?${search}`, '');
  }, [path]);

  const open = useCallback((next: string): void => {
    // A component names an address of the app; a rendered link carries the base the app is served under.
    const path = base !== '' && next.startsWith(base) ? next.slice(base.length) : next;
    window.history.pushState({}, '', base + path);
    setPath(path);
    // A press on a link scrolls the page it opens to its top, as a page load would: the work area is the column that
    // scrolls, not the window.
    document.querySelector('[data-testid="shell-content"]')?.scrollTo({ top: 0 });
  }, [base]);

  useEffect(() => {
    const follow = (): void => { setPath(window.location.pathname.slice(base.length) + window.location.search); };
    window.addEventListener('popstate', follow);
    return () => { window.removeEventListener('popstate', follow); };
  }, [base]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadBootstrap = useCallback(async (): Promise<Bootstrap | undefined> => {
    const read = await readBootstrap(base, language);
    if (!alive.current) return undefined;
    bootstrapVersion.current += 1;
    if (read.bootstrap === undefined) {
      setFailure(read.message ?? 'the bootstrap could not be read');
      return undefined;
    }
    setBootstrap(read.bootstrap);
    setNavigation(read.navigation ?? null);
    return read.bootstrap;
  }, [base, language]);

  // The bootstrap and the navigation are read once per structure and language: what they hold changes only with the
  // product's files or the reader's language.
  useEffect(() => {
    setBootstrap(null);
    void loadBootstrap();
  }, [loadBootstrap]);

  // The document says the language the reader reads and names the product, as the browser's tab shows them.
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('knowledge.title', { product: navigation?.product ?? 'madarch' });
  }, [language, navigation?.product, t]);

  const ask = useCallback(async (composition: PageComposition, variables: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    const answer = await postQuery<Record<string, unknown>>(base, composition.operation, variables);
    if (!alive.current) return;
    setBusy(false);
    const codes = codesOf(answer.errors);
    if (answer.errors.length > 0) {
      if (codes.includes(STALE_STRUCTURE) && bootstrap !== null) {
        const read = await loadBootstrap();
        if (read !== undefined) {
          const again = composePage(read, { ...address.page, lang: language, role, ...(address.home ? { home: true } : {}) });
          if (again.findings.length === 0) await ask(again, again.variables);
        }
        return;
      }
      setFailure(answer.errors.map((error) => error.message).join('; '));
      return;
    }
    setFailure(null);
    setLoaded({ composition, variables, data: splitResponse(composition, answer.data ?? {}) });
  }, [address, base, bootstrap, language, loadBootstrap, role]);

  // One page view, one operation: the page is composed from the bootstrap and the address, then asked once.
  const compositionKey = `${language}\u0000${role}\u0000${path}\u0000${bootstrap?.structureRevision ?? ''}`;
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
    const composition = composePage(bootstrap, { ...address.page, lang: language, role });
    if (composition.findings.length > 0) {
      setFailure(composition.findings.map((finding) => `${finding.file}:${String(finding.line)}: ${finding.message}`).join('\n'));
      setLoaded(null);
      return;
    }
    void ask(composition, composition.variables);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositionKey]);

  const reload = useCallback((variables: Record<string, unknown>): void => {
    if (loaded === null) return;
    const merged = { ...loaded.variables, ...variables };
    // A key set to null drops the variable, as the connection's own default asks.
    for (const [key, value] of Object.entries(variables)) if (value === null) delete merged[key];
    void ask(loaded.composition, merged);
  }, [ask, loaded]);

  const runtime: PageRuntime = { base, language, busy, open, reload };
  const section: FramePage | null = address.frame;
  const here = `/${path.split('?')[0] ?? ''}`;
  const tasks = { home: address.home, frame: section };
  const navigationPanel = (after: () => void): ReactElement => (
    <FrameNavigation navigation={navigation} base={base} path={here} open={(next) => { open(next); after(); }} tasks={tasks} />
  );
  const [menuOpen, setMenuOpen] = useState(false);
  // The graph could not be read at all: the frame says so instead of a page.
  if (bootstrap === null && failure !== null) {
    return <ShellError><Paragraph role="alert" data-testid="wiki-error">{failure}</Paragraph></ShellError>;
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
  // The kit's own review surface stands at `/kit`; every other section of the frame waits for its page.
  const page = section === null ? null : section === 'kit' ? <KitPage /> : <RebuildingPage word={frameWord(section, t)} />;
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={100}>
      <Stack layout="shell" data-testid="wiki-app">
        <ShellSidebar id="app-nav" aria-label={t('navigation.aria')}>
          <Stack layout="navigation">{navigationPanel(() => undefined)}</Stack>
        </ShellSidebar>
        <ShellMain>
          <ShellFixed data-testid="shell-fixed">
            <FrameToolbar
              product={navigation?.product ?? null}
              base={base}
              task={address.home ? t('knowledge.home') : section === null ? null : frameWord(section, t)}
              language={language}
              role={role}
              roles={bootstrap.roles}
              busy={busy}
              menu={<PhoneNavigation open={menuOpen} onOpenChange={setMenuOpen}>{navigationPanel(() => { setMenuOpen(false); })}</PhoneNavigation>}
              open={open}
              onLanguage={(next) => { void setWikiLanguage(next); }}
              onRole={(next) => { setRole(next); keepRole(next); }}
              onReload={() => { void loadBootstrap(); }}
            />
          </ShellFixed>
          <ShellRow>
            <ShellScroll data-testid="shell-content">
              <ShellDocument>
                <main data-testid="wiki-main">
                  {failure === null ? null : (
                    <Alert variant="problem" className="mb-4" data-testid="wiki-error">
                      <AlertTitle>{t('knowledge.noSuchPage')}</AlertTitle>
                      <AlertDescription>{failure}</AlertDescription>
                    </Alert>
                  )}
                  {page}
                  {loaded === null ? null : <PageView composition={loaded.composition} data={loaded.data} runtime={runtime} />}
                </main>
              </ShellDocument>
            </ShellScroll>
          </ShellRow>
        </ShellMain>
      </Stack>
    </TooltipProvider>
  );
}
