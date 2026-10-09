/**
 * The app itself: a home page naming the product and listing its pages, and a
 * page per document. It asks for the page list about once a second and, when
 * the wiki's revision changes, refetches the open page, so a file saved in the
 * product shows within two seconds with no reload and no server restart
 * (requirements `pages`, `live`, `app`). It stops asking while the reader is
 * not looking at the page and resumes when they come back.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { getProduct, getPages, getPage, type Product, type PageList, type Page } from './api.js';
import { routeOf, addressOfPage } from './routes.js';
import { Markdown, PageLink } from './view.js';
import { routeContext } from './hold.js';
export type RouteSnapshot = { name: 'home' } | { name: 'page'; path: string };

/** How far apart the app asks for the page list again, about once a second. */
export const defaultTickMs = 1000;

export type AppProps = { tickMs?: number };

export function App({ tickMs = defaultTickMs }: AppProps): ReactElement {
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

  // The page list, asked again about once a second; asks nothing while the reader is away.
  useEffect(() => {
    let alive = true;
    const loadList = async (): Promise<void> => {
      try {
        const nextList = await getPages();
        const nextProduct = await getProduct();
        if (!alive) return;
        setData({ product: nextProduct, list: nextList });
        setList(nextList);
        setError(null);
      } catch (caught: unknown) {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    loadList();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadList();
    }, tickMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
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
        <PageReader key={"page:" + route.path + ":" + list.revision} path={route.path} heldPaths={heldPaths} />
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
 * page is read again from the working tree.
 */
export function PageReader({ path, heldPaths }: { path: string; heldPaths: ReadonlySet<string> }): ReactElement {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const loadPage = async (): Promise<void> => {
      try {
        const next = await getPage(path);
        if (!alive) return;
        setPage(next);
        setError(null);
      } catch (caught: unknown) {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    loadPage();
    return () => {
      alive = false;
    };
  }, [path]);

  if (error !== null) return <ErrorLine message={error} />;
  if (page === null) return <p className="loading">Waiting for the wiki</p>;
  return (
    <main id="page">
      <h1>{page.title}</h1>
      <Markdown text={page.markdown} />
    </main>
  );
}

/** A failed read, shown to the reader as a short message naming what was asked for. */
export function ErrorLine({ message }: { message: string }): ReactElement {
  return <p className="error">{message}</p>;
}
