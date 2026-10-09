/**
 * The app's routes, read from location.pathname (decision 0018 and the draft's
 * design): the home page at `/`, a page at `/p/` plus the page's path within
 * the product, for example `/p/docs/vision.md`. The server answers a path it
 * does not hold with index.html, so the app routes on the address alone.
 */

export type Route = { name: 'home' } | { name: 'page'; path: string };

/** Reads a route from the address. Anything else answers the home page. */
export function routeOf(pathname: string): Route {
  if (pathname.startsWith('/p/')) {
    return { name: 'page', path: decodeURIComponent(pathname.slice('/p/'.length)) };
  }
  return { name: 'home' };
}

/** The address of a page, `/p/` plus its path within the product. */
export function addressOfPage(path: string): string {
  return '/p/' + path.split('/').map(encodeURIComponent).join('/');
}
