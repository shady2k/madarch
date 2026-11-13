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
      if (key === 'status') return async () => ({ manifest: 'not-filled', fill: { state: 'idle' }, publication: manifestPublicationState(folder)?.status === 'failed' ? 'failed' : 'pending' });
      if (key === 'startFill') return async () => ({ started: true, fill: { state: 'running' } });
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
      if (['identity', 'products', 'status', 'fill', 'fillSelected'].includes(name)) continue;
      const handled = await handle(new Request('http://localhost/api/catalog'));
      expect(handled.response.status).toBe(503);
      expect(handled.response.headers.get('retry-after')).toBe('1');
      expect(await handled.response.json()).toEqual({ publication: 'pending', message: expect.stringContaining('catalogue is being published') });
    }
    expect(reads()).toBe(0);
  });

  test('status is healthy and Fill is accepted during publication; failed publication rejects Fill', async () => {
    const folder = '/tmp/publication-status-fill';
    const { part, reads } = fixture(folder);
    setManifestPublicationState(folder, { status: 'pending' });
    const status = await part.status(new Request('http://localhost/api/status'));
    expect(status.response.status).toBe(200);
    expect(await status.response.json()).toEqual({ manifest: 'not-filled', fill: { state: 'idle' }, publication: 'pending' });
    const fill = await part.fill(new Request('http://localhost/api/fill', { method: 'POST' }));
    expect(fill.response.status).toBe(202);
    expect(reads()).toBe(0);
    setManifestPublicationState(folder, { status: 'failed', message: 'schema publication failed' });
    const failed = await part.fill(new Request('http://localhost/api/fill', { method: 'POST' }));
    expect(failed.response.status).toBe(503);
    expect(await failed.response.json()).toEqual({ publication: 'failed', message: expect.stringContaining('schema publication failed') });
    expect((await part.status(new Request('http://localhost/api/status'))).response.status).toBe(200);
  });

  test('failure is explicit; successful publication releases the reader', async () => {
    const folder = '/tmp/publication-failed';
    const { part, reads } = fixture(folder);
    setManifestPublicationState(folder, { status: 'failed', message: 'database unavailable' });
    const failure = await part.run(new Request('http://localhost/api/run'));
    expect(failure.response.status).toBe(503);
    expect(failure.response.headers.get('retry-after')).toBeNull();
    expect(await failure.response.json()).toEqual({ publication: 'failed', message: expect.stringContaining('database unavailable') });
    expect(reads()).toBe(0);
    setManifestPublicationState(folder, { status: 'published' });
    expect(manifestPublicationReady(folder)).toBe(true);
    await part.run(new Request('http://localhost/api/run'));
    expect(reads()).toBe(1);
  });
});
