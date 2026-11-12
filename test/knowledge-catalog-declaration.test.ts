import { expect, test } from 'bun:test';
import { catalogKinds } from '../src/knowledge/catalog-view.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { FieldDecl, KindsManifest } from '../src/product/manifest/kinds.js';

test('catalogue declaration fields carry published human labels and locations, not engine columns', async () => {
  const file = '/product/madarch/kinds.yaml';
  const fields: FieldDecl[] = [
    { name: 'summary', type: 'text', line: 12, producers: ['reader'] },
    { name: 'opaque', type: 'integer', line: 13, producers: ['reader'] },
    ...['id', 'said_by', 'context_id'].map((name) => ({ name, type: 'text' as const, line: 14, producers: ['reader'] })),
  ];
  const manifest = { file, groups: new Map(), properties: new Map([
    ['summary', { name: 'summary', labels: { en: 'Summary', ru: 'Краткое описание' }, format: 'text', line: 2 }],
  ]), kinds: new Map([
    ['widget', { name: 'widget', source: 'graph', template: '', title: 'summary', relations: [], fields, line: 9 }],
  ]) } as unknown as KindsManifest;
  const ctx = { productFolder: '/product', manifest, graph: { kindCounts: async () => [] }, markdown: new Map() } as unknown as RenderContext;
  const rows = await catalogKinds(ctx);
  expect(rows[0]!.declaration).toEqual({ file, line: 9 });
  expect(rows[0]!.fields).toEqual([
    { ...fields[0]!, labels: { en: 'Summary', ru: 'Краткое описание' }, declaration: { file, line: 12 } },
    { ...fields[1]!, declaration: { file, line: 13 } },
  ]);
  expect(rows[0]!.count).toBe(0);
  expect(rows[0]!.state).toBe('never');
});
