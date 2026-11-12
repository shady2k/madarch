import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { catalogKinds, groupViews } from '../src/knowledge/catalog-view.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import type { RenderContext } from '../src/knowledge/blocks.js';

const folder = mkdtempSync(join(tmpdir(), 'catalog-payload-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

test('the full starter catalogue stays bounded while single-kind details retain declarations', async () => {
  seedStarterSet(folder);
  const read = readKinds(folder);
  if (!read.present) throw new Error('starter manifest is absent');
  const manifest = read.manifest;
  const ctx = { manifest, graph: { kindCounts: async () => [] }, markdown: new Map() } as unknown as RenderContext;
  const kinds = await catalogKinds(ctx);
  for (const kind of kinds) {
    const declaration = manifest.kinds.get(kind.kind);
    const producers = [...manifest.plugins!.values()]
      .filter((plugin) => declaration !== undefined && plugin.declaration?.produces.some((output) => output.kind === '*' || output.kind === declaration.name))
      .map((plugin) => plugin.id).sort();
    expect(kind.plugins ?? []).toEqual(producers);
    if (declaration === undefined) expect(kind.pluginFolders).toBeUndefined();
  }
  const catalog = { product: { name: 'bare', id: 'tiny' }, language: 'en', groups: groupViews(manifest), kinds, findings: [] };
  const product = { folder, catalog: async () => catalog } as unknown as KnowledgeProduct;
  const part = createKnowledgePart({
    json: (status, body) => new Response(JSON.stringify(body), { status }),
    refused: (status, body) => ({ response: new Response(JSON.stringify(body), { status }) }),
    errorLog: () => undefined,
  }, product, () => []);
  const list = await part.catalog(new Request('http://localhost/api/catalog'));
  const text = await list.response.text();
  expect(Buffer.byteLength(text)).toBeLessThan(300_000);
  const summary = JSON.parse(text);
  expect(summary.kinds).toHaveLength(manifest.catalog!.kinds.size);
  expect(summary.groups).toEqual(catalog.groups);
  for (const kind of kinds) {
    const row = summary.kinds.find((entry: { kind: string }) => entry.kind === kind.kind);
    const { fields, relations, sources, pluginFolders, ...metadata } = kind;
    expect(row).toEqual({ ...metadata, ...(sources?.length ? { sourcesAvailable: true } : {}) });
    const detail = await part.catalog(new Request(`http://localhost/api/catalog?kind=${encodeURIComponent(kind.kind)}`));
    expect(detail.response.status).toBe(200);
    expect(await detail.response.json()).toEqual(kind);
  }
  const unknown = await part.catalog(new Request('http://localhost/api/catalog?kind=unknown'));
  expect(unknown.response.status).toBe(404);
});
