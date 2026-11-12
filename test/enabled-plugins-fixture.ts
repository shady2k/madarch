import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

/** Keeps only exercised plugins; excluded bindings become passive provenance, with every field retained. */
export function useFixturePlugins(folder: string, ids: readonly string[]): void {
  const file = join(folder, 'madarch', 'kinds.yaml');
  const manifest = parseDocument(readFileSync(file, 'utf8'));
  const plugins = (manifest.toJS().plugins ?? []) as { id: string }[];
  for (const id of ids) {
    if (!plugins.some(plugin => plugin.id === id)) throw new Error(`${file}:1: fixture requests undeclared plugin ${id}`);
  }
  const removed = new Set(plugins.filter(plugin => !ids.includes(plugin.id)).map(plugin => plugin.id));
  const kinds = manifest.toJS().kinds ?? {};
  for (const [name, kind] of Object.entries(kinds) as [string, { fields?: { binding?: unknown }[] }][]) {
    for (const [index, field] of (kind.fields ?? []).entries()) {
      if (typeof field.binding !== 'string') continue;
      const producer = field.binding.split('@')[0]!;
      if (!removed.has(producer)) continue;
      manifest.deleteIn(['kinds', name, 'fields', index, 'binding']);
      manifest.setIn(['kinds', name, 'fields', index, 'producers'], [producer]);
    }
  }
  manifest.set('plugins', plugins.filter(plugin => ids.includes(plugin.id)));
  writeFileSync(file, manifest.toString());
}
