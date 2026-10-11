/**
 * The app itself: a home page naming the product and listing its documents as
 * quiet kind groups, and a page per document. The page list is asked for once
 * at load, and again only when the wiki's Server-Sent Events stream carries
 * a change event — the server watches the product's working tree — so a file
 * saved in the product shows within two seconds with no reload and no server
 * restart (requirements `pages`, `live`, `app`). A tab the reader leaves alone
 * adds no requests beyond its one open stream: there is no polling. The
 * stream reconnects with backoff when it drops, and the backoff resets when a
 * stream answers again. It keeps one list request in flight at a time, aborts
 * it on cleanup, and never lets an older answer overwrite a newer one —
 * including while the tab is hidden, where the stream keeps delivering. A
 * failed page read is retried on its own, bounded, with the failure shown
 * while the retries run.
 */
import { useContext, useEffect, useRef, useState, useCallback, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTextIcon } from 'lucide-react';
import { relativeTime } from './i18n.js';
import { getProduct, getPages, getPage, type Product, type PageList, type Page } from './api.js';
import { routeOf, addressOfPage } from './routes.js';
import { Markdown, PageLink } from './view.js';
import { routeContext, statusContext } from './hold.js';
import { groupNav, groupOf, kindOf, wordLabel, Shell } from './shell.js';
import { wordCount } from './text.js';
export type RouteSnapshot = { name: 'home' } | { name: 'page'; path: string };

/** How many times one page read is tried before the app gives up on it. */
export const pageTriesLimit = 3;

/** How long one read of the wiki may run before it is aborted and its failure shown. */
export const defaultPollTimeoutMs = 5000;

/** The first gap before a dropped stream is asked for again; each miss doubles it. */
export const defaultReconnectMs = 1000;

/** The longest gap a dropped stream waits before it is asked for again. */
const maxReconnectMs = 15_000;

/** Where the wiki's change stream answers. */
export const EVENTS_PATH = '/api/events';

export type AppProps = {
  pageRetryMs?: number;
  pollTimeoutMs?: number;
  /** The reconnect base for the tests; a dropped stream doubles it each miss. */
  reconnectMs?: number;
};

export function App({ pageRetryMs = 1000, pollTimeoutMs = defaultPollTimeoutMs, reconnectMs = defaultReconnectMs }: AppProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [route, setRoute] = useState<RouteSnapshot>(() => routeOf(window.location.pathname));
  const [data, setData] = useState<{ product: Product; list: PageList } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [streamConnected, setStreamConnected] = useState(false);
  const productName = data?.product.name;
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
    document.title = t('brand.title', { product: productName ?? 'madarch' });
  }, [i18n.resolvedLanguage, productName, t]);

  // The route follows the history bar: back and forward as much as the app's own moves.
  useEffect(() => {
    const onPop = (): void => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The wiki's page list, asked for at load and again only on the stream's
  // change events (there is no polling): one request in flight at a time,
  // aborted on cleanup, and an answer from an older request never wins
  // against a newer one. The reader reads regardless of the tab's
  // visibility, since the stream delivers events while the tab is hidden too.
  useEffect(() => {
    let alive = true;
    let controller: AbortController | undefined;
    let asking = false;
    let requestTurn = 0;
    let lastAnsweredTurn = 0;
    const loadList = async (): Promise<void> => {
      if (asking) return;
      asking = true;
      controller = new AbortController();
      const turn = ++requestTurn;
      // A request that never answers must not hold the flag forever: the
      // read is aborted when its own timeout passes and the failure shown;
      // the stream's next change event asks again (finding 4).
      let timeoutFired = false;
      const timeout = pollTimeoutMs > 0
        ? window.setTimeout(() => {
            timeoutFired = true;
            controller?.abort();
          }, pollTimeoutMs)
        : undefined;
      // The request that was actually in flight when the timeout fired, so
      // the sentence names it and not always the page list (finding 2.11).
      let current: string = '/api/pages';
      try {
        const nextList = await getPages(controller.signal);
        current = '/api/product';
        const nextProduct = await getProduct(controller.signal);
        if (!alive || lastAnsweredTurn > turn) return;
        lastAnsweredTurn = turn;
        setData({ product: nextProduct, list: nextList });
        setError(null);
      } catch (caught: unknown) {
        const aborted = caught instanceof DOMException && caught.name === 'AbortError';
        const expired = aborted && timeoutFired;
        if (alive && lastAnsweredTurn <= turn && (!aborted || expired)) {
          // A read the app itself killed at its own timeout is named as
          // such: what was being read — the request that timed out — and
          // that it timed out — never the abort's raw message (finding 2.10).
          if (expired) setError(`Could not read the page list: the request to ${current} timed out after ${pollTimeoutMs} ms`);
          else setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        asking = false;
      }
    };
    loadList();
    return () => {
      alive = false;
      controller?.abort();
      controller = undefined;
      asking = false;
    };
  }, [pollTimeoutMs, refresh]);

  // The stream itself: one long-lived request, held for the tab's whole
  // life, reading Server-Sent Events frames. A change event asks for the
  // list again; a dropped stream reconnects with backoff, resetting the
  // backoff when a stream answers again.
  useEffect(() => {
    let alive = true;
    let misses = 0;
    let timer: number | undefined;
    const decoder = new TextDecoder();
    let stream: AbortController | undefined;
    const open = async (): Promise<void> => {
      if (!alive) return;
      stream = new AbortController();
      try {
        const response = await fetch(EVENTS_PATH, { signal: stream.signal });
        if (!response.ok || response.body === null) {
          throw new Error(String('the stream to ' + EVENTS_PATH + ' answered ' + response.status));
        }
        setStreamConnected(true);
        // A stream that answers after a miss is asked with one resync: the
        // events the dead stream swallowed are read as a change now.
        if (misses > 0) {
          misses = 0;
          setRefresh((held) => held + 1);
        }
        const reader = response.body.getReader();
        let frame = '';
        while (alive) {
          const next = await reader.read();
          if (next.done) break;
          frame += decoder.decode(next.value, { stream: true });
          let end: number;
          while ((end = frame.indexOf('\n\n')) !== -1) {
            const lines = frame.slice(0, end).split('\n');
            frame = frame.slice(end + 2);
            const kind = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
            if (kind === 'change') setRefresh((held) => held + 1);
          }
        }
        throw new Error('the stream to ' + EVENTS_PATH + ' ended');
      } catch (caught: unknown) {
        const stop = !alive || (caught instanceof DOMException && caught.name === 'AbortError');
        if (!stop && alive) {
          setStreamConnected(false);
          misses += 1;
          const wait = Math.min(maxReconnectMs, reconnectMs * 2 ** (misses - 1));
          timer = window.setTimeout(open, wait);
        }
      }
    };
    open();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.abort();
      stream = undefined;
    };
  }, [reconnectMs]);

  if (error !== null) return <ErrorLine message={error} />;
  if (data === null) return <p className="loading">{t('loading.wiki')}</p>;

  const list = data.list;
  const heldPaths = new Set(list.pages.map((meta) => meta.path));
  return (
    <StatusBridge streamConnected={streamConnected}>
      <routeContext.Provider value={{ path: route.name === 'page' ? route.path : undefined, heldPaths }}>
        <Shell product={data.product} list={list}>
        {route.name === 'home' ? (
          <HomePage product={data.product} list={list} />
        ) : (
          <PageReader
            key={"page:" + route.path + ":" + list.revision}
            path={route.path}
            heldPaths={heldPaths}
            retryMs={pageRetryMs}
          />
        )}
        </Shell>
      </routeContext.Provider>
    </StatusBridge>
  );
}

/** The home page's status is localized in its current UI language. */
/** Whether two status lines name exactly the same parts; the same line is one state, not a new one. */
function sameLine(held: readonly string[] | null, parts: readonly string[] | null): boolean {
  if (held === parts) return true;
  if (held === null || parts === null || held.length !== parts.length) return false;
  return held.every((word, at) => word === parts[at]);
}

/**
 * Holds the shell's status line: whatever is open publishes here, and the
 * shell's bottom edge reads it. The setter is stable and lets an
 * unchanged line through, so a publish never re-renders for nothing.
 */
export function StatusBridge({ children, streamConnected }: { children: ReactNode; streamConnected: boolean }): ReactElement {
  const [line, setLine] = useState<readonly string[] | null>(null);
  const publish = useCallback((parts: readonly string[] | null): void => {
    setLine((held) => (sameLine(held, parts) ? held : parts));
  }, []);
  return (
    <statusContext.Provider value={{ publish, parts: line, connection: streamConnected ? 'live' : 'reconnecting' }}>
      {children}
    </statusContext.Provider>
  );
}

/**
 * The home page, in the mockup's overview language: an eyebrow, the product's
 * name, a short lead, then the documents as quiet groups — a small kind label
 * with its count beside it, and the documents as icon plus title rows on the
 * navigation's row rhythm. No boxed cards, no divider lines between links, no
 * underlines: the kind and its small muted count say what a reader is
 * choosing between, the rows read like the sidebar's. A product with no
 * pages yet says so plainly in the lead.
 */
export function HomePage({ product, list }: { product: Product; list: PageList }): ReactElement {
  const groups = groupNav(list.pages);
  const documents = list.pages.length;
  const { publish } = useContext(statusContext);
  const { t } = useTranslation();
  const documentUnit = t('units.document', { count: documents });
  const groupUnit = t('units.group', { count: groups.length });
  useEffect(() => {
    publish(documents === 0 ? null : [
      t('status.documents', { count: documents, unit: documentUnit }),
      t('status.formatMarkdown'),
      t('status.formatUtf8'),
    ]);
    return () => publish(null);
  }, [publish, documents, documentUnit, t]);
  const lead = documents === 0
    ? t('home.noPages', { product: product.name })
    : t('home.lead', { product: product.name, count: documents, documentUnit, groupCount: groups.length, groupUnit });
  return (
    <main id="home">
      <p className="eyebrow">{t('home.overview')}</p>
      <h1 className="app-title">{product.name}</h1>
      <p className="home-lead" data-testid="home-lead">{lead}</p>
      {documents === 0 ? null : (
        <div className="home-groups">
          {groups.map((group) => (
            <section key={group.name} data-kind={group.name} className="home-group mt-7 first:mt-0">
              <header className="home-group-head">
                <h2 className="text-ink">{t('groups.' + group.name, { defaultValue: wordLabel(group.name) })}</h2>
                <span className="home-count" data-testid="card-count">{group.pages.length}</span>
              </header>
              <ul className="home-rows">
                {group.pages.map((meta) => (
                  <li key={meta.path}>
                    <PageLink path={meta.path} className="home-row">
                      <FileTextIcon aria-hidden="true" className="home-row-icon" />
                      <span className="home-row-title">{meta.title}</span>
                    </PageLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

/**
 * One page, asked for and refetched for each revision of the list the app was
 * last told: a file saved in the product changes the revision, so the open
 * page is read again from the working tree. A read that fails is retried on
 * its own, a bounded number of times, whatever the revision says; the last
 * failure's reason stays on the screen while the retries run.
 */
export function PageReader({
  path,
  heldPaths,
  retryMs = 1000,
}: {
  path: string;
  heldPaths: ReadonlySet<string>;
  retryMs?: number;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  // Whether the document rendered its own first-level heading: the fallback
  // title above it then leaves the DOM, so a page holds exactly one h1.
  const [ownTitle, setOwnTitle] = useState(false);
  const pageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setPage(null);
    setError(null);
    setTries(0);
    setOwnTitle(false);
  }, [path]);

  // The decision reads the rendered truth: the Markdown's first child being
  // an h1 is what the renderer itself produced, never a text guess.
  useEffect(() => {
    if (page === null) setOwnTitle(false);
    else setOwnTitle(pageRef.current?.querySelector('.reading > h1:first-child') !== null);
  }, [page]);

  // The shell's bottom status bar is fed by what is open: this page's word
  // count and its format facts. The facts leave when the page leaves, so a
  // home page is never shown a document's count.
  const { publish } = useContext(statusContext);
  const words = page === null ? 0 : wordCount(page.markdown);
  const wordUnit = t('units.word', { count: words });
  useEffect(() => {
    if (page === null) publish(null);
    else publish([
      t('status.words', { count: words, unit: wordUnit }),
      t('status.formatMarkdown'),
      t('status.formatUtf8'),
    ]);
    return () => publish(null);
  }, [page, publish, t, words, wordUnit]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let attempt = 0;
    const loadPage = async (): Promise<void> => {
      attempt++;
      setTries(attempt);
      try {
        const next = await getPage(path);
        if (!alive) return;
        setPage(next);
        setError(null);
      } catch (caught: unknown) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        if (attempt < pageTriesLimit) timer = window.setTimeout(loadPage, retryMs);
      }
    };
    loadPage();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [path, retryMs, revisionKey(heldPaths)]);

  if (error !== null && page === null && tries >= pageTriesLimit)
    return <ErrorLine message={error} />;
  if (error !== null) return <ErrorLine message={error} />;
  if (page === null) return <p className="loading">{t('loading.wiki')}</p>;
  return (
    <main id="page" ref={pageRef}>
      {/* The mockup's document header: the kind as an eyebrow above the title.
       * Exactly one h1 per page: when the document renders its own
       * first-level heading, the fallback title above it is not rendered
       * (the checkpoint's doubled-title defect). */}
      <div className="document-meta eyebrow">
        <strong className="eyebrow-kind">{t('kinds.' + kindOf(path, groupOf(path)).toLowerCase(), { defaultValue: kindOf(path, groupOf(path)) })}</strong>
        <span className="eyebrow-dot" aria-hidden="true">•</span>
        <span className="eyebrow-secondary">{page.changedAt ? t('document.changed', { when: relativeTime(page.changedAt, i18n.resolvedLanguage) }) : t('document.local')}</span>
      </div>
      {!ownTitle && <h1 className="app-title">{page.title}</h1>}
      <Markdown text={page.markdown} />
    </main>
  );
}

/** The revision of the list the app was last told, so a changed wiki refetches the open page. */
function revisionKey(heldPaths: ReadonlySet<string>): string {
  return [...heldPaths].sort().join('\u0000');
}

/** A failed read, shown to the reader as a short message naming what was asked for. */
export function ErrorLine({ message }: { message: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <p className="error">
      <strong>{t('errors.prefix')}</strong>{' '}
      <span>{t('errors.details', { message })}</span>
    </p>
  );
}
