import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { StarterFile } from '../src/knowledge/seed.js';

export const fixtureProductFiles: StarterFile[] = ['plugin.json', 'contract.json', 'main.ts'].map(name => ({
  path: `plugins/fixture-product/${name}`,
  content: readFileSync(join(import.meta.dir, 'fixtures/plugin-product', name), 'utf8'),
}));

/** Bind the starter root to the deterministic producer whose files the caller supplies. */
export function withFixtureProduct(text: string): string {
  const manifest = parseDocument(text);
  const body = manifest.toJS();
  const plugins = body.plugins ?? [];
  if (!plugins.some((plugin: { id: string }) => plugin.id === 'fixture-product')) {
    plugins.push({ id: 'fixture-product', version: 1, path: 'plugins/fixture-product', inputs: [], outputs: ['product'],
      closure: fixtureProductFiles.map(file => file.path) });
  }
  manifest.set('plugins', plugins);
  for (const [index] of body.kinds.product.fields.entries()) {
    manifest.deleteIn(['kinds', 'product', 'fields', index, 'binding']);
    manifest.setIn(['kinds', 'product', 'fields', index, 'producers'], ['fixture-product']);
  }
  return manifest.toString();
}
