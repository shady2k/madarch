import { expect, test } from 'bun:test';
import { catalogKinds } from '../src/knowledge/catalog-view.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { FieldDecl, KindsManifest } from '../src/product/manifest/kinds.js';

test('catalogue declaration fields carry published human labels and locations, not engine columns', async () => {
  const file = '/product/madarch/kinds.yaml';
  const fields: FieldDecl[] = [
    { name: 'summary', type: 'text', line: 12, binding: { kind: 'agent', description: 'A short account of the item.' } },
    { name: 'opaque', type: 'integer', line: 13, producers: ['reader'] },
    ...['id', 'said_by', 'context_id'].map((name) => ({ name, type: 'text' as const, line: 14, producers: ['reader'] })),
  ];
  const manifest = { file, groups: new Map(), properties: new Map([
    ['publicOnly', { name: 'publicOnly', labels: { en: 'Published property', ru: 'Опубликованное свойство' }, format: 'text', line: 3 }],
    ['summary', { name: 'summary', labels: { en: 'Summary', ru: 'Краткое описание' }, format: 'text', line: 2 }],
  ]), kinds: new Map([
    ['widget', { name: 'widget', source: 'graph', template: '', title: 'summary', relations: [], details: ['publicOnly', 'summary'], fields, line: 9 }],
  ]) } as unknown as KindsManifest;
  const ctx = { productFolder: '/product', manifest, graph: { kindCounts: async () => [] }, markdown: new Map() } as unknown as RenderContext;
  const rows = await catalogKinds(ctx);
  expect(rows[0]!.declaration).toEqual({ file, line: 9 });
  expect(rows[0]!.fields).toEqual([
    { name: 'publicOnly', labels: { en: 'Published property', ru: 'Опубликованное свойство' }, declaration: { file, line: 3 } },
    { name: 'summary', labels: { en: 'Summary', ru: 'Краткое описание' }, meaning: 'A short account of the item.', declaration: { file, line: 2 } },
  ]);
  expect(rows[0]!.count).toBe(0);
  expect(rows[0]!.state).toBe('never');
});


test('published plugin meanings resolve the bound field and tolerate an unavailable contract', async () => {
  const field = { name: 'summary', type: 'text', binding: { kind: 'plugin', plugin: 'reader', major: '1', field: 'description' } };
  const manifest = { file: '/product/madarch/kinds.yaml', groups: new Map(),
    properties: new Map([['summary', { name: 'summary', labels: { en: 'Summary', ru: 'Описание' }, format: 'text', line: 2 }]]),
    kinds: new Map([['widget', { name: 'widget', source: 'graph', template: '', title: 'summary', relations: [], details: ['summary'], fields: [field], line: 9 }]]),
    plugins: new Map([['reader', { path: 'plugins/reader' }]]),
  } as unknown as KindsManifest;
  const ctx = { productFolder: '/product', manifest, graph: { kindCounts: async () => [] }, markdown: new Map() } as unknown as RenderContext;
  expect((await catalogKinds(ctx))[0]!.fields![0]!.meaning).toBeUndefined();
  const plugins = new Map([['reader', { path: 'plugins/reader', contract: { vertices: [{ kind: 'widget', fields: [{ name: 'description', meaning: 'The plugin describes the item.' }] }] } }]]);
  const published = await catalogKinds({ ...ctx, manifest: { ...manifest, plugins } } as unknown as RenderContext);
  expect(published[0]!.fields![0]!.meaning).toBe('The plugin describes the item.');
});
