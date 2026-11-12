import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

/** Declares exactly the plugins this fixture exercises, without changing its kinds or fields. */
export function useFixturePlugins(folder: string, ids: readonly string[]): void {
  const file = join(folder, 'madarch', 'kinds.yaml');
  const manifest = parseDocument(readFileSync(file, 'utf8'));
  const plugins = (manifest.toJS().plugins ?? []) as { id: string }[];
  for (const id of ids) {
    if (!plugins.some(plugin => plugin.id === id)) throw new Error(`${file}:1: fixture requests undeclared plugin ${id}`);
  }
  manifest.set('plugins', plugins.filter(plugin => ids.includes(plugin.id)));
  writeFileSync(file, manifest.toString());
}
