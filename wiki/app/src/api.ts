/**
 * The wiki's API, as served by the madarch server (docs/changes/draft-product/
 * change.md, "The API"). The app holds no document bytes itself: everything it
 * shows is read from this API, and every refusal reaches the reader as a short
 * message naming what was asked for.
 */

export type Product = {
  id: string;
  name: string;
};

export type PageMeta = {
  path: string;
  title: string;
  url: string;
};

export type PageList = {
  pages: PageMeta[];
  revision: string;
};

export type Page = {
  path: string;
  title: string;
  markdown: string;
  revision?: string;
};

/** An API read that failed, with a message naming what was asked for. */
export class RequestError extends Error {
  constructor(what: string, reason: string) {
    super(`Could not ${what}: ${reason}`);
    this.name = 'RequestError';
  }
}

/** Reads one JSON answer from the API, naming `what a reader was waiting for` on failure. */
export async function readJson<T>(what: string, url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(what, `the request to ${url} failed (${reason})`);
  }
  if (!response.ok) {
    let reason = `the server answered ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        'message' in (body as Record<string, unknown>) &&
        typeof (body as Record<string, unknown>).message === 'string'
      ) {
        reason = String((body as Record<string, unknown>).message);
      }
    } catch {
      // keep the status line as the reason
    }
    throw new RequestError(what, reason);
  }
  try {
    return (await response.json()) as T;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(what, `the answer from ${url} was not JSON (${reason})`);
  }
}

export const getProduct = (): Promise<Product> =>
  readJson<Product>('read the product', '/api/product');

export const getPages = (): Promise<PageList> =>
  readJson<PageList>('read the page list', '/api/pages');

export const getPage = (path: string): Promise<Page> =>
  readJson<Page>(`read the page ${path}`, `/api/page?path=${encodeURIComponent(path)}`);
