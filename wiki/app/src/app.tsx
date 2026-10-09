/**
 * The app itself: a home page naming the product and listing its pages, and a
 * page per document. It asks for the page list about once a second and, when
 * the wiki's revision changes, refetches the open page, so a file saved in the
 * product shows within two seconds with no reload and no server restart
 * (requirements `pages`, `live`, `app`). It keeps one list request in flight
 * at a time, aborts it on cleanup, and never lets an older answer overwrite a
 * newer one; it asks also while the tab is hidden, and asks at once when the
 * tab becomes visible again. A failed page read is retried on its own, bounded,
 * with the failure shown while the retries run.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { getProduct, getPages, getPage, type Product, type PageList, type Page } from './api.js';
import { routeOf, addressOfPage } from './routes.js';
import { Markdown, PageLink } from './view.js';
import { routeContext } from './hold.js';
export type RouteSnapshot = { name: 'home' } | { name: 'page'; path: string };

/** How far apart the app asks for the page list again, about once a second. */
export const defaultTickMs = 1000;

/** How many times one page read is tried before the app gives up on it. */
export const pageTriesLimit = 3;

/** How long one poll may run before it is aborted and its failure shown. */
export const defaultPollTimeoutMs = 5000;

export type AppProps = { tickMs?: number; pageRetryMs?: number; pollTimeoutMs?: number };

export function App({ tickMs = defaultTickMs, pageRetryMs = 1000, pollTimeoutMs = defaultPollTimeoutMs }: AppProps): ReactElement {
  const [route, setRoute] = useState<RouteSnapshot>(() => routeOf(window.location.pathname));
  const [list, setList] = useState<PageList | null>(null);
  const [data, setData] = useState<{ product: Product; list: PageList } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The route follows the history bar: back and forward as much as the app's own moves.
  useEffect(() => {
    const onPop = (): void => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The page list, asked again about once a second: one request in flight at a
  // time, aborted on cleanup, and an answer from an older request never wins
  // against a newer one. The reader is asked for regardless of the tab's
  // visibility, so a hidden page stays live too.
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
      // poll is aborted when its own timeout passes, the failure is shown,
      // and the next tick asks again (finding 4).
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
        setList(nextList);
        setError(null);
      } catch (caught: unknown) {
        const aborted = caught instanceof DOMException && caught.name === 'AbortError';
        const expired = aborted && timeoutFired;
        if (alive && lastAnsweredTurn <= turn && (!aborted || expired)) {
          // A poll the app itself killed at its own timeout is named as
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
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') loadList();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(loadList, tickMs);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
      controller?.abort();
      controller = undefined;
      asking = false;
    };
  }, [tickMs]);

  if (error !== null) return <ErrorLine message={error} />;
  if (data === null || list === null) return <p className="loading">Waiting for the wiki</p>;

  const heldPaths = new Set(list.pages.map((meta) => meta.path));
  return (
    <routeContext.Provider value={{ path: route.name === 'page' ? route.path : undefined, heldPaths }}>
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
    </routeContext.Provider>
  );
}

/** The home page: the product's name, its pages, or the plain truth when it has none. */
export function HomePage({ product, list }: { product: Product; list: PageList }): ReactElement {
  return (
    <main id="home">
      <h1>{product.name}</h1>
      {list.pages.length === 0 ? (
        <p className="no-pages">{product.name} has no pages yet.</p>
      ) : (
        <ul className="page-list">
          {list.pages.map((meta) => (
            <li key={meta.path}>
              <PageLink path={meta.path}>{meta.title}</PageLink>
            </li>
          ))}
        </ul>
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
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    setPage(null);
    setError(null);
    setTries(0);
  }, [path]);

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
  if (page === null) return <p className="loading">Waiting for the wiki</p>;
  return (
    <main id="page">
      <h1>{page.title}</h1>
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
  return <p className="error">{message}</p>;
}
