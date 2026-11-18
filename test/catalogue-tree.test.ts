import { expect, test } from 'bun:test';
import { parse } from 'yaml';
import { starterManifestText } from './catalog-folder-fixture.js';

test('whole-catalogue-tree: product is the sole root, every kind is reachable, and dependencies are acyclic', () => {
  const { kinds } = parse(starterManifestText()) as { kinds: Record<string, { 'derives-from'?: string[] }> };
  const roots = Object.keys(kinds).filter(name => (kinds[name]!['derives-from'] ?? []).length === 0).sort();
  expect(roots).toEqual(['product']);
  const children = new Map(Object.keys(kinds).map(name => [name, [] as string[]]));
  for (const [name, kind] of Object.entries(kinds)) for (const parent of kind['derives-from'] ?? []) {
    expect(kinds[parent]).toBeDefined();
    children.get(parent)!.push(name);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    expect(visiting.has(name)).toBe(false);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of children.get(name)!) visit(child);
    visiting.delete(name);
    visited.add(name);
  };
  // Check cycles even in disconnected components, then check reachability independently.
  for (const name of Object.keys(kinds)) visit(name);
  visited.clear();
  visit('product');
  expect([...visited].sort()).toEqual(Object.keys(kinds).sort());
  expect(kinds['product-profile']!['derives-from']).toEqual(['product']);
  expect(kinds['code.repository']!['derives-from']).toContain('product-profile');
});
