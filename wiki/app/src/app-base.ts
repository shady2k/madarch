/** Base path for a product-mounted wiki, otherwise the local serve root. */
export function appBase(pathname: string = typeof window === 'undefined' ? '/' : window.location.pathname): string {
  const product = pathname.match(/^(\/products\/[^/]+)(?:\/|$)/);
  return product?.[1] ?? '';
}
export function appPath(path: string, pathname?: string): string {
  const base = appBase(pathname);
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Strip a product mount prefix before resolving the app's client-side route. */
export function appRoute(pathname: string = typeof window === 'undefined' ? '/' : window.location.pathname): string {
  const base = appBase(pathname);
  return base && pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
}
