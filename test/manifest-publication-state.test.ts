import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { manifestPublicationReady, manifestPublicationState, setManifestPublicationState } from '../src/product/manifest-publication-state.js';

function fixture(folder: string) {
  let reads = 0;
  const product = new Proxy({ folder }, {
    get(target, key) {
      if (key === 'folder') return target.folder;
      return () => { reads++; throw new Error('a pending reader must not open the graph or prepare schemas'); };
    },
  }) as unknown as KnowledgeProduct;
  const part = createKnowledgePart({
    json: (status, body) => Response.json(body, { status }),
    refused: (status, body) => ({ response: Response.json(body, { status }) }),
    errorLog: () => {},
  }, product, () => []);
  return { part, reads: () => reads };
}

describe('startup manifest publication', () => {
  test('unmanaged products keep their normal reader path; folder names are normalized', () => {
    const folder = '/tmp/publication-unmanaged';
    expect(manifestPublicationState(folder)).toBeUndefined();
    expect(manifestPublicationReady(folder)).toBe(true);
    setManifestPublicationState(`${folder}/../publication-normalized`, { status: 'pending' });
    expect(manifestPublicationReady(resolve(folder, '../publication-normalized'))).toBe(false);
  });

  test('all graph-dependent routes refuse pending reads without touching the product', async () => {
    const folder = '/tmp/publication-pending';
    setManifestPublicationState(folder, { status: 'pending' });
    const { part, reads } = fixture(folder);
    for (const [name, handle] of Object.entries(part)) {
      if (name === 'identity' || name === 'products') continue;
      const handled = await handle(new Request('http://localhost/api/catalog'));
      expect(handled.response.status).toBe(503);
      expect(handled.response.headers.get('retry-after')).toBe('1');
      expect(await handled.response.json()).toEqual({ publication: 'pending', message: expect.stringContaining('catalogue is being published') });
    }
    expect(reads()).toBe(0);
  });

  test('failure is explicit; successful publication releases the reader', async () => {
    const folder = '/tmp/publication-failed';
    const { part, reads } = fixture(folder);
    setManifestPublicationState(folder, { status: 'failed', message: 'database unavailable' });
    const failure = await part.catalog(new Request('http://localhost/api/catalog'));
    expect(failure.response.status).toBe(503);
    expect(failure.response.headers.get('retry-after')).toBeNull();
    expect(await failure.response.json()).toEqual({ publication: 'failed', message: expect.stringContaining('database unavailable') });
    expect(reads()).toBe(0);
    setManifestPublicationState(folder, { status: 'published' });
    expect(manifestPublicationReady(folder)).toBe(true);
    await part.catalog(new Request('http://localhost/api/catalog'));
    expect(reads()).toBe(1);
  });
});
