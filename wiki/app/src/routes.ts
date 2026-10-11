/**
 * The app's routes, read from location.pathname (decision 0018 and the draft's
 * design): the home page at `/`, a page at `/p/` plus the page's path within
 * the product, for example `/p/docs/vision.md`, and — since feature E
 * (madarch-iuc.15) — the Architecture section's pages under
 * `/p/madarch/architecture` (the views' index), `/p/madarch/view/<scope>`
 * (one view; the landscape's scope is `_landscape`) and
 * `/p/madarch/element/<id>` (one model element). The server answers a path
 * it does not hold with index.html, so the app routes on the address alone.
 */

export type Route =
  | { name: 'home' }
  | { name: 'page'; path: string }
  | { name: 'architecture' }
  | { name: 'view'; scope: string }
  | { name: 'element'; id: string }
  | { name: 'stage'; stage: string }
  | { name: 'repos' };

/** The address prefix of the wiki's own (non-document) pages. */
export const ARCHITECTURE_PREFIX = '/p/madarch/';

/** The landscape view's scope in an address. */
export const LANDSCAPE_SCOPE = '_landscape';

/** The Architecture index's address. */
export const architectureAddress = (): string => '/p/madarch/architecture';

/** One view page's address. */
export function addressOfView(scope: string): string {
  return `/p/madarch/view/${encodeURIComponent(scope === '' ? LANDSCAPE_SCOPE : scope)}`;
}

/** One element page's address. */
export function addressOfElement(id: string): string {
  return `/p/madarch/element/${encodeURIComponent(id)}`;
}

/** Reads a route from the address. Anything else answers the home page. */
export function routeOf(pathname: string): Route {
  if (pathname === `${ARCHITECTURE_PREFIX}architecture`) return { name: 'architecture' };
  if (pathname.startsWith(`${ARCHITECTURE_PREFIX}view/`)) {
    let scope = decodeURIComponent(pathname.slice(`${ARCHITECTURE_PREFIX}view/`.length));
    if (scope === LANDSCAPE_SCOPE) scope = '';
    return { name: 'view', scope };
  }
  if (pathname.startsWith(`${ARCHITECTURE_PREFIX}element/`)) {
    return { name: 'element', id: decodeURIComponent(pathname.slice(`${ARCHITECTURE_PREFIX}element/`.length)) };
  }
  if (pathname.startsWith('/p/')) {
    return { name: 'page', path: decodeURIComponent(pathname.slice('/p/'.length)) };
  }
  if (pathname === REPOS_ADDRESS) {
    return { name: 'repos' };
  }
  if (pathname.startsWith('/s/')) {
    try {
      return { name: 'stage', stage: decodeURIComponent(pathname.slice('/s/'.length)) };
    } catch {
      return { name: 'home' };
    }
  }
  return { name: 'home' };
}

/** The address of a page, `/p/` plus its path within the product. */
export function addressOfPage(path: string): string {
  return '/p/' + path.split('/').map(encodeURIComponent).join('/');
}

/** The address of the repositories' page. */
export const REPOS_ADDRESS = '/r';

/** The address of a stage page, `/s/` plus the stage's id. */
export function addressOfStageRoute(stage: string): string {
  return '/s/' + encodeURIComponent(stage);
}
