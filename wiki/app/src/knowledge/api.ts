import { appPath } from '../app-base.js';
import { readJson, RequestError } from '../api.js';
import type { EntityListing, PageModel, ProductChoice, SourceFile, WikiStatus } from './types.js';

/** The wiki's status: manifest, kinds, repositories, fill. */
export const getStatus = (signal?: AbortSignal): Promise<WikiStatus> => readJson<WikiStatus>('read the wiki', '/api/k/status', signal);

/** One entity's page. */
export const getPage = (id: string, signal?: AbortSignal): Promise<PageModel> => readJson<PageModel>(`read the page of ${id}`, `/api/k/page?id=${encodeURIComponent(id)}`, signal);

/** One page of a kind's entities. */
export function getEntities(kind: string, options: { q?: string; after?: string } = {}, signal?: AbortSignal): Promise<EntityListing> {
  const query = new URLSearchParams({ kind, limit: '100' });
  if (options.q !== undefined && options.q !== '') query.set('q', options.q);
  if (options.after !== undefined) query.set('after', options.after);
  return readJson<EntityListing>(`list the entities of kind ${kind}`, `/api/k/entities?${query.toString()}`, signal);
}

/** One file of a repository, as the graph was filled from it. */
export function getSource(repo: string | null, path: string, signal?: AbortSignal): Promise<SourceFile> {
  const query = new URLSearchParams({ path });
  if (repo !== null) query.set('repo', repo);
  return readJson<SourceFile>(`read the source of ${path}`, `/api/k/source?${query.toString()}`, signal);
}

/** The products the selector offers: the home's, or this one alone. */
export async function getProducts(signal?: AbortSignal): Promise<ProductChoice[]> {
  const mounted = /^\/products\/[^/]+/.test(window.location.pathname);
  try {
    if (mounted) {
      const response = await fetch('/api/products', { signal });
      if (response.ok) return ((await response.json()) as { products: ProductChoice[] }).products;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
  }
  return (await readJson<{ products: ProductChoice[] }>('list the products', '/api/k/products', signal)).products;
}

/** Starts the fill; the answer is the server's refusal in words when it cannot start. */
export async function startFill(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(appPath('/api/k/fill'), { method: 'POST' });
  } catch (error) {
    throw new RequestError('start the fill', `the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.ok) return;
  let reason = `the server answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') reason = body.message;
  } catch {
    // the status stands
  }
  throw new RequestError('start the fill', reason, response.status);
}

/** The wiki's one change stream: the server says `change` when a file of the product or a commit of the fill changes what a page shows. */
export const eventsAddress = (): string => appPath('/api/events');
